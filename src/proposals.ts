import type { AppConfig } from "./config.js";
import {
  CLAUDE_MODEL,
  generateIssueFromSources,
  proposeTopicsFromSources,
} from "./claude.js";
import { getRecentStoryFingerprints } from "./dedup.js";
import { createIssue, getPool, updateIssue, upsertStory } from "./db.js";
import type { GenerateResult } from "./generate.js";
import { fetchMarineConditions } from "./marine.js";
import {
  getNewestDraftSources,
  markDraftSourcesUsed,
  type DraftSource,
} from "./sources.js";
import type {
  ProposalSourceRef,
  ProposalTopic,
  TopicProposal,
} from "./types.js";

export type ProposeResult = {
  proposed: boolean;
  reason?: string;
  proposal?: TopicProposal;
  sourceCount: number;
};

function mapRow(row: {
  id: string;
  status: TopicProposal["status"];
  sources: ProposalSourceRef[] | string;
  topics: ProposalTopic[] | string;
  marine: TopicProposal["marine"] | string;
  issue_id: string | null;
  created_at: string;
  updated_at: string;
}): TopicProposal {
  return {
    id: row.id,
    status: row.status,
    sources:
      typeof row.sources === "string" ? JSON.parse(row.sources) : row.sources,
    topics: typeof row.topics === "string" ? JSON.parse(row.topics) : row.topics,
    marine: typeof row.marine === "string" ? JSON.parse(row.marine) : row.marine,
    issue_id: row.issue_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function listPendingProposals(
  databaseUrl: string
): Promise<TopicProposal[]> {
  const { rows } = await getPool(databaseUrl).query(
    `SELECT id::text, status, sources, topics, marine,
            issue_id::text, created_at::text, updated_at::text
     FROM topic_proposals
     WHERE status = 'pending'
     ORDER BY created_at DESC
     LIMIT 20`
  );
  return rows.map(mapRow);
}

export async function getProposal(
  databaseUrl: string,
  id: string
): Promise<TopicProposal | null> {
  const { rows } = await getPool(databaseUrl).query(
    `SELECT id::text, status, sources, topics, marine,
            issue_id::text, created_at::text, updated_at::text
     FROM topic_proposals
     WHERE id = $1`,
    [id]
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function saveProposalTopics(
  databaseUrl: string,
  id: string,
  topics: ProposalTopic[]
): Promise<TopicProposal | null> {
  const { rows } = await getPool(databaseUrl).query(
    `UPDATE topic_proposals
     SET topics = $2::jsonb, updated_at = now()
     WHERE id = $1 AND status = 'pending'
     RETURNING id::text, status, sources, topics, marine,
               issue_id::text, created_at::text, updated_at::text`,
    [id, JSON.stringify(topics)]
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function discardProposal(
  databaseUrl: string,
  id: string
): Promise<boolean> {
  const { rowCount } = await getPool(databaseUrl).query(
    `UPDATE topic_proposals
     SET status = 'discarded', updated_at = now()
     WHERE id = $1 AND status = 'pending'`,
    [id]
  );
  return (rowCount ?? 0) > 0;
}

/** Propose topics for review — does not mark sources used or create an issue. */
export async function proposeTopicsFromNewestSources(
  config: AppConfig,
  options?: { limit?: number }
): Promise<ProposeResult> {
  if (!config.anthropicApiKey) {
    return {
      proposed: false,
      reason:
        "Claude API key is not set. Add AI_KEY on the Railway web service, then redeploy.",
      sourceCount: 0,
    };
  }

  const maxTopics = options?.limit ?? config.findingsBatchSize;
  const sources = await getNewestDraftSources(
    config.databaseUrl,
    Math.max(maxTopics, 12)
  );
  if (!sources.length) {
    return {
      proposed: false,
      reason: "No unused transcripts (or findings) found to propose topics from.",
      sourceCount: 0,
    };
  }

  const recentTopics = await getRecentStoryFingerprints(config.databaseUrl, 4);
  const topics = await proposeTopicsFromSources({
    apiKey: config.anthropicApiKey,
    sources,
    maxTopics,
    recentTopics,
  });

  let marine: TopicProposal["marine"] = {
    weather: "",
    high_tides: "",
    low_tides: "",
    high_tide_label: "",
  };
  try {
    const today = new Date().toISOString().slice(0, 10);
    marine = await fetchMarineConditions(config, today);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`Marine autofill failed during propose: ${message}`);
  }

  const sourceRefs: ProposalSourceRef[] = sources.map((s) => ({
    id: s.id,
    sourceTable: s.sourceTable,
    kind: s.kind,
    title: s.title || s.content.slice(0, 60),
  }));

  const { rows } = await getPool(config.databaseUrl).query(
    `INSERT INTO topic_proposals (sources, topics, marine, status)
     VALUES ($1::jsonb, $2::jsonb, $3::jsonb, 'pending')
     RETURNING id::text, status, sources, topics, marine,
               issue_id::text, created_at::text, updated_at::text`,
    [JSON.stringify(sourceRefs), JSON.stringify(topics), JSON.stringify(marine)]
  );

  return {
    proposed: true,
    proposal: mapRow(rows[0]),
    sourceCount: sources.length,
  };
}

async function reloadSources(
  databaseUrl: string,
  refs: ProposalSourceRef[]
): Promise<DraftSource[]> {
  const all = await getNewestDraftSources(databaseUrl, 100);
  const byKey = new Map(all.map((s) => [`${s.sourceTable}:${s.id}`, s]));
  const out: DraftSource[] = [];
  for (const ref of refs) {
    const hit = byKey.get(`${ref.sourceTable}:${ref.id}`);
    if (hit) out.push(hit);
  }
  // If sources were already used or filtered out, still allow accept from notes.
  return out.length ? out : all.slice(0, refs.length || 6);
}

/** Accept selected topics → write full draft issue + mark sources used. */
export async function acceptTopicProposal(
  config: AppConfig,
  proposalId: string,
  topicKeys?: string[]
): Promise<{ accepted: boolean; reason?: string; result?: GenerateResult }> {
  if (!config.anthropicApiKey) {
    return {
      accepted: false,
      reason: "Claude API key is not set.",
    };
  }

  const proposal = await getProposal(config.databaseUrl, proposalId);
  if (!proposal || proposal.status !== "pending") {
    return { accepted: false, reason: "Proposal not found or already handled." };
  }

  let selected = proposal.topics.filter((t) => t.selected);
  if (topicKeys?.length) {
    const allow = new Set(topicKeys);
    selected = proposal.topics.filter((t) => allow.has(t.key));
  }
  if (!selected.length) {
    return { accepted: false, reason: "Select at least one topic to write." };
  }

  const sources = await reloadSources(config.databaseUrl, proposal.sources);
  const recentTopics = await getRecentStoryFingerprints(config.databaseUrl, 4);
  const today = new Date().toISOString().slice(0, 10);

  const issue = await createIssue(config.databaseUrl, {
    issue_date: today,
    subject: `The Ebb & Flow — draft ${today}`,
    status: "draft",
    weather: proposal.marine.weather ?? "",
    high_tides: proposal.marine.high_tides ?? "",
    low_tides: proposal.marine.low_tides ?? "",
    high_tide_label: proposal.marine.high_tide_label ?? "",
  });

  const generated = await generateIssueFromSources({
    apiKey: config.anthropicApiKey,
    issue,
    sources: sources.length ? sources : proposal.sources.map((ref) => ({
      kind: "transcript" as const,
      id: ref.id,
      sourceTable: ref.sourceTable,
      title: ref.title,
      content: selected.map((t) => t.source_notes).join("\n\n"),
      meta: "",
      occurredAt: null,
      url: "",
      category: "Transcript",
    })),
    maxTopics: selected.length,
    recentTopics,
    approvedTopics: selected,
  });

  const updatedIssue = await updateIssue(config.databaseUrl, issue.id, {
    subject: generated.subject,
    preheader: generated.preheader,
    intro: generated.intro,
    coming_up: generated.coming_up,
  });
  if (!updatedIssue) {
    throw new Error("Failed to save generated issue");
  }

  const savedStories = [] as Awaited<ReturnType<typeof upsertStory>>[];
  for (const story of generated.stories) {
    const approved = selected[story.position - 1];
    savedStories.push(
      await upsertStory(config.databaseUrl, issue.id, {
        position: story.position,
        toc_title: story.toc_title || story.title.slice(0, 48),
        title: story.title,
        eyebrow: story.eyebrow || "Local",
        summary: story.summary,
        why_it_matters: story.why_it_matters,
        url: "",
        image_url: null,
        quote: story.quote,
        quote_attribution: story.quote_attribution,
        source_notes: story.source_notes || approved?.source_notes || "",
        finding_id: null,
      })
    );
  }

  if (sources.length) {
    await markDraftSourcesUsed(config.databaseUrl, sources, issue.id);
  }

  await getPool(config.databaseUrl).query(
    `UPDATE topic_proposals
     SET status = 'accepted', issue_id = $2, topics = $3::jsonb, updated_at = now()
     WHERE id = $1`,
    [proposalId, issue.id, JSON.stringify(selected)]
  );

  return {
    accepted: true,
    result: {
      issue: updatedIssue,
      stories: savedStories.sort((a, b) => a.position - b.position),
      model: CLAUDE_MODEL,
    },
  };
}
