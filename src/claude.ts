import Anthropic from "@anthropic-ai/sdk";
import type { RecentStoryRef } from "./dedup.js";
import {
  buildStoryGroundingNotes,
  checkIssueNames,
} from "./nameCheck.js";
import type { DraftSource } from "./sources.js";
import type {
  FactReviewFinding,
  Issue,
  ProposalTopic,
  Story,
} from "./types.js";
import { randomUUID } from "node:crypto";

export type FactReviewResult = {
  ok: boolean;
  summary: string;
  findings: FactReviewFinding[];
  /** Corrected copy when errors were found (or null if clean / no rewrite). */
  corrected: GeneratedIssueCopy | null;
};

export interface GeneratedStoryCopy {
  position: number;
  toc_title: string;
  title: string;
  eyebrow: string;
  summary: string;
  why_it_matters: string;
  quote: string | null;
  quote_attribution: string | null;
  /** Grounding notes / excerpt kept on the story for editors. */
  source_notes?: string;
}

export interface GeneratedIssueCopy {
  subject: string;
  preheader: string;
  intro: string;
  coming_up: string[];
  stories: GeneratedStoryCopy[];
}

const SYSTEM = `You are the newsroom editor for "The Ebb & Flow", a warm weekly local newsletter for Ketchikan / Tongass Narrows, Alaska.

Voice: neighborly, clear, specific, never corporate. Short sentences. No emojis. No hype.

Your job is to REFINE raw meeting/interview transcripts into a small set of digestible newsletter TOPICS, then write polished copy for each topic that fits a weekly email template (up to 6 stories).

Accuracy rules (critical):
- Copy names, titles, vote counts, dollar amounts, dates, and places EXACTLY as they appear in the source transcript/notes.
- Never invent or "correct" a person's name — not even from memory or "common knowledge."
- If a person's name is unclear, incomplete, or only partly audible, use a role ("the harbor master", "a council member") or omit the name.
- Never swap in a different spelling you think is "more correct." Transcript spelling wins.
- Never invent quotes. If the exact words are not in the source, set quote to null.`;

const REVIEW_SYSTEM = `You are a meticulous fact-checker for "The Ebb & Flow", a local newsletter for Ketchikan / Tongass Narrows, Alaska.

You MUST use the web_search tool to verify checkable claims against public internet sources
(city/borough sites, Alaska news outlets, official agendas/minutes, NOAA, etc.).

Priority order (must follow):
1) Draft copy vs transcript/source_notes — names, quotes, and vote counts MUST appear in the transcript text.
2) Public web — use for roles, orgs, meeting outcomes, and dates. Web may WARN about spelling, but must NOT replace a person name with a web spelling that is absent from the transcript.

If the web contradicts the transcript on a person's name, keep the transcript form or omit the name / use a role. Never invent a hybrid spelling.
If a name/detail is unsupported by the transcript, treat it as an error and remove it in corrections (prefer role/omit over a web-only name).
Do not invent new news. Prefer omitting unsupported details over guessing.
No emojis. After searching, return JSON only as your final answer.`;

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = (fenced?.[1] ?? text).trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Claude response did not include JSON");
  }
  return JSON.parse(raw.slice(start, end + 1));
}

function storyInput(story: Story) {
  return {
    position: story.position,
    source_notes: story.source_notes || "",
    title: story.title || "",
    toc_title: story.toc_title || "",
    eyebrow: story.eyebrow || "",
    summary: story.summary || "",
    why_it_matters: story.why_it_matters || "",
    quote: story.quote,
    quote_attribution: story.quote_attribution,
    url: story.url || "",
  };
}

/** Newsletter drafting is locked to Claude Fable 5 only. */
export const CLAUDE_MODEL = "claude-fable-5" as const;

async function callClaudeJson(params: {
  apiKey: string;
  userPrompt: string;
  system?: string;
  maxTokens?: number;
}): Promise<unknown> {
  const client = new Anthropic({ apiKey: params.apiKey });
  const response = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: params.maxTokens ?? 16000,
    system: params.system ?? SYSTEM,
    messages: [{ role: "user", content: params.userPrompt }],
  });

  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();

  if (!text) {
    throw new Error("Claude returned an empty response");
  }

  return extractJson(text);
}

function textFromMessage(content: Anthropic.Messages.ContentBlock[]): string {
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

/**
 * Claude Messages call with Anthropic web_search (server tool), including
 * pause_turn continuation so multi-search fact-checks can finish.
 */
async function callClaudeJsonWithWebSearch(params: {
  apiKey: string;
  userPrompt: string;
  system?: string;
  maxTokens?: number;
  maxSearches?: number;
}): Promise<unknown> {
  const client = new Anthropic({ apiKey: params.apiKey });
  const messages: Anthropic.Messages.MessageParam[] = [
    { role: "user", content: params.userPrompt },
  ];

  const tools: Anthropic.Messages.WebSearchTool20250305[] = [
    {
      type: "web_search_20250305",
      name: "web_search",
      max_uses: params.maxSearches ?? 12,
      allowed_callers: ["direct"],
      user_location: {
        type: "approximate",
        city: "Ketchikan",
        region: "Alaska",
        country: "US",
        timezone: "America/Juneau",
      },
    },
  ];

  let response = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: params.maxTokens ?? 16000,
    system: params.system ?? REVIEW_SYSTEM,
    messages,
    tools,
  });

  // Continue when the API pauses a long server-tool turn.
  let guards = 0;
  while (response.stop_reason === "pause_turn" && guards < 6) {
    guards += 1;
    messages.push({ role: "assistant", content: response.content });
    response = await client.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: params.maxTokens ?? 16000,
      system: params.system ?? REVIEW_SYSTEM,
      messages,
      tools,
    });
  }

  const text = textFromMessage(response.content);
  if (!text) {
    throw new Error(
      "Claude web fact-check returned no text. Try again, or check that web search is enabled for your API key."
    );
  }

  return extractJson(text);
}

/**
 * Refine raw transcripts into digestible topics and draft the full issue.
 * One long transcript may become multiple topics; related scraps may merge.
 */
function recentTopicsBlock(recent?: RecentStoryRef[]): string {
  if (!recent?.length) return "";
  return `
Avoid repeating these recent newsletter topics (skip near-duplicates; find a new angle or drop):
${JSON.stringify(recent.slice(0, 40), null, 2)}
`;
}

/** Propose digestible topics for editor review (no full issue polish yet). */
export async function proposeTopicsFromSources(params: {
  apiKey: string;
  sources: DraftSource[];
  maxTopics?: number;
  recentTopics?: RecentStoryRef[];
}): Promise<ProposalTopic[]> {
  if (!params.sources.length) {
    throw new Error("No transcripts/sources provided for topic proposal.");
  }

  const maxTopics = Math.min(Math.max(params.maxTopics ?? 6, 1), 6);
  const inputs = params.sources.map((source, index) => ({
    index: index + 1,
    kind: source.kind,
    title: source.title,
    category: source.category,
    meta: source.meta,
    when: source.occurredAt,
    transcript: source.content.slice(0, 40_000),
  }));

  const userPrompt = `Propose digestible newsletter TOPICS from these raw transcripts for editor review.

Raw sources:
${JSON.stringify(inputs, null, 2)}
${recentTopicsBlock(params.recentTopics)}

Return ONLY valid JSON:
{
  "topics": [
    {
      "toc_title": "short TOC title",
      "title": "full headline",
      "eyebrow": "Section · detail",
      "summary": "2-3 digestible sentences",
      "why_it_matters": "one short sentence",
      "quote": "optional quote or null",
      "quote_attribution": "optional attribution or null",
      "source_notes": "which source(s) + key facts grounding this topic"
    }
  ]
}

Rules:
- Propose ${Math.min(3, maxTopics)}-${maxTopics} topics (not one per transcript).
- Split long transcripts; merge related scraps.
- Drop procedural filler and near-duplicates of recent topics.
- Keep facts faithful; no invented quotes or names.
- Copy person names EXACTLY as spoken/spelled in the transcript, or use a role / omit.
- Every topic needs source_notes grounding (which source + key facts, with names spelled as in the transcript).`;

  const parsed = (await callClaudeJson({
    apiKey: params.apiKey,
    userPrompt,
  })) as { topics?: ProposalTopic[] };

  const topics: ProposalTopic[] = [];
  for (const raw of parsed.topics ?? []) {
    if (topics.length >= maxTopics) break;
    const title = String(raw.title ?? "").trim();
    if (!title) continue;
    topics.push({
      key: randomUUID(),
      selected: true,
      toc_title: String(raw.toc_title ?? "").trim() || title.slice(0, 48),
      title,
      eyebrow: String(raw.eyebrow ?? "").trim() || "Local",
      summary: String(raw.summary ?? "").trim(),
      why_it_matters: String(raw.why_it_matters ?? "").trim(),
      source_notes: String(raw.source_notes ?? "").trim(),
      quote: raw.quote ? String(raw.quote).trim() : null,
      quote_attribution: raw.quote_attribution
        ? String(raw.quote_attribution).trim()
        : null,
    });
  }

  if (!topics.length) {
    throw new Error("Claude returned no topics to review");
  }
  return topics;
}

export async function generateIssueFromSources(params: {
  apiKey: string;
  issue: Issue;
  sources: DraftSource[];
  maxTopics?: number;
  recentTopics?: RecentStoryRef[];
  /** When accepting a proposal, lock Claude to these approved outlines. */
  approvedTopics?: ProposalTopic[];
}): Promise<GeneratedIssueCopy> {
  if (!params.sources.length) {
    throw new Error("No transcripts/sources provided for drafting.");
  }

  const maxTopics = Math.min(Math.max(params.maxTopics ?? 6, 1), 6);
  const inputs = params.sources.map((source, index) => ({
    index: index + 1,
    kind: source.kind,
    title: source.title,
    category: source.category,
    meta: source.meta,
    when: source.occurredAt,
    url: source.url,
    transcript: source.content.slice(0, 40_000),
  }));

  const approvedBlock = params.approvedTopics?.length
    ? `
Editor-approved topics (write polished copy for THESE in this order; do not invent new topics):
${JSON.stringify(params.approvedTopics, null, 2)}
`
    : "";

  const userPrompt = `Refine the raw database transcripts below into digestible newsletter TOPICS, then draft this week's Ebb & Flow email.

Issue date: ${params.issue.issue_date}
Volume label: ${params.issue.volume_label || "(none)"}
Current subject: ${params.issue.subject}

Raw sources (analyze all of them; do not treat each source as one story):
${JSON.stringify(inputs, null, 2)}
${approvedBlock}
${recentTopicsBlock(params.recentTopics)}

Return ONLY valid JSON matching this shape:
{
  "subject": "string — email subject line",
  "preheader": "string — one sentence inbox preview",
  "intro": "string — 1-2 sentences after 'Good morning, {name}.' Do not include the greeting.",
  "coming_up": ["string", "string", "string"],
  "stories": [
    {
      "position": 1,
      "toc_title": "short TOC title",
      "title": "full headline",
      "eyebrow": "Section · detail",
      "summary": "2-3 digestible sentences a busy reader can scan",
      "why_it_matters": "one short sentence",
      "quote": "optional quote text without surrounding quotation marks, or null",
      "quote_attribution": "optional attribution without leading em dash, or null",
      "source_notes": "2-5 bullet-like lines: which source index/title this topic came from + key facts (spell names exactly as in the transcript)"
    }
  ]
}

Topic refinement rules:
- Extract ${Math.min(3, maxTopics)}-${maxTopics} digestible TOPICS — not one story per transcript${params.approvedTopics?.length ? " (follow the approved list)" : ""}.
- Split a long transcript into multiple topics when it covers distinct news (votes, schedules, quotes, decisions).
- Merge tightly related scraps from different sources into one topic when that helps readers.
- Drop procedural filler (roll call, agenda chrome, "can you hear me") unless it is the news.
- Skip near-duplicates of recent newsletter topics.
- Position 1 is the lead — the strongest news for neighbors this week.
- Keep facts faithful; do not invent votes, names, dates, or quotes.
- Person names must be copied character-for-character from the transcript. If unsure, use a role or omit — never "fix" a name.
- If a quote is not clearly present, set quote and quote_attribution to null.
- coming_up should be 2-4 short teasers from unfinished threads in the transcripts.
- Every story must include source_notes grounding the topic.`;

  const parsed = (await callClaudeJson({
    apiKey: params.apiKey,
    userPrompt,
  })) as GeneratedIssueCopy;

  return normalizeTopics(parsed, maxTopics, params.sources);
}

/** Rewrite existing story slots from their source notes (admin regenerate). */
export async function generateIssueCopy(params: {
  apiKey: string;
  issue: Issue;
  stories: Story[];
}): Promise<GeneratedIssueCopy> {
  if (!params.stories.length) {
    throw new Error("Add at least one story (with source notes) before generating.");
  }

  const userPrompt = `Refine the source notes / transcripts below into digestible newsletter topics and draft this week's Ebb & Flow email.

Issue date: ${params.issue.issue_date}
Volume label: ${params.issue.volume_label || "(none)"}
Current subject: ${params.issue.subject}

Each item's source_notes may contain a full TRANSCRIPT. Read carefully, pull out the real news as scannable topics, and write newsletter-ready fields.

Inputs:
${JSON.stringify(params.stories.map(storyInput), null, 2)}

Return ONLY valid JSON matching this shape:
{
  "subject": "string — email subject line",
  "preheader": "string — one sentence inbox preview",
  "intro": "string — 1-2 sentences after 'Good morning, {name}.' Do not include the greeting.",
  "coming_up": ["string", "string", "string"],
  "stories": [
    {
      "position": 1,
      "toc_title": "short TOC title",
      "title": "full headline",
      "eyebrow": "Section · detail",
      "summary": "2-3 digestible sentences grounded in the transcript",
      "why_it_matters": "one short sentence",
      "quote": "optional quote text without surrounding quotation marks, or null",
      "quote_attribution": "optional attribution without leading em dash, or null"
    }
  ]
}

Rules:
- Treat source_notes as raw material to refine into digestible topics — not text to lightly polish.
- Include every input story position in the output (same positions).
- Position 1 is the lead story and should be the strongest news.
- Keep facts faithful; do not invent votes, names, dates, or quotes.
- Person names must appear in that story's source_notes / TRANSCRIPT text exactly. Never invent or autocorrect a name.
- If a quote is not clearly present, set quote and quote_attribution to null.
- coming_up should be 2-4 short teaser bullets from unfinished threads.`;

  const parsed = (await callClaudeJson({
    apiKey: params.apiKey,
    userPrompt,
  })) as GeneratedIssueCopy;

  return normalizeGenerated(parsed, params.stories);
}

function normalizeStory(story: GeneratedStoryCopy, position: number): GeneratedStoryCopy {
  return {
    position,
    toc_title: String(story.toc_title ?? "").trim(),
    title: String(story.title ?? "").trim(),
    eyebrow: String(story.eyebrow ?? "").trim(),
    summary: String(story.summary ?? "").trim(),
    why_it_matters: String(story.why_it_matters ?? "").trim(),
    quote: story.quote ? String(story.quote).trim() : null,
    quote_attribution: story.quote_attribution
      ? String(story.quote_attribution).trim()
      : null,
    source_notes: story.source_notes
      ? String(story.source_notes).trim()
      : undefined,
  };
}

function normalizeTopics(
  parsed: GeneratedIssueCopy,
  maxTopics: number,
  sources: DraftSource[]
): GeneratedIssueCopy {
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid Claude JSON");
  }

  const rawStories = Array.isArray(parsed.stories) ? parsed.stories : [];
  const stories: GeneratedStoryCopy[] = [];

  for (const story of rawStories) {
    if (stories.length >= maxTopics) break;
    const position = stories.length + 1;
    const normalized = normalizeStory(story, position);
    if (!normalized.title) continue;
    // Always keep raw transcript text on the story so name gates can verify.
    normalized.source_notes = buildStoryGroundingNotes(
      normalized.source_notes,
      sources
    );
    stories.push(normalized);
  }

  if (!stories.length) {
    throw new Error("Claude returned no digestible topics from the transcripts");
  }

  const comingUp = Array.isArray(parsed.coming_up)
    ? parsed.coming_up.map((item) => String(item).trim()).filter(Boolean)
    : [];

  return {
    subject: String(parsed.subject ?? "").trim() || "The Ebb & Flow",
    preheader: String(parsed.preheader ?? "").trim(),
    intro: String(parsed.intro ?? "").trim(),
    coming_up: comingUp,
    stories,
  };
}

function normalizeGenerated(
  parsed: GeneratedIssueCopy,
  inputStories: Story[]
): GeneratedIssueCopy {
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid Claude JSON");
  }

  const storiesByPosition = new Map<number, GeneratedStoryCopy>();
  for (const story of parsed.stories ?? []) {
    const position = Number(story.position);
    if (!Number.isInteger(position) || position < 1 || position > 6) continue;
    storiesByPosition.set(position, normalizeStory(story, position));
  }

  const stories: GeneratedStoryCopy[] = inputStories.map((input) => {
    const generated = storiesByPosition.get(input.position);
    if (!generated?.title) {
      throw new Error(`Claude omitted story position ${input.position}`);
    }
    return generated;
  });

  const comingUp = Array.isArray(parsed.coming_up)
    ? parsed.coming_up.map((item) => String(item).trim()).filter(Boolean)
    : [];

  return {
    subject: String(parsed.subject ?? "").trim() || "The Ebb & Flow",
    preheader: String(parsed.preheader ?? "").trim(),
    intro: String(parsed.intro ?? "").trim(),
    coming_up: comingUp,
    stories,
  };
}

/**
 * Fact-check draft + transcript notes against each other and the public web.
 * Uses Anthropic web_search. Returns findings and a corrected rewrite when needed.
 */
export async function factReviewIssue(params: {
  apiKey: string;
  issue: Issue;
  stories: Story[];
}): Promise<FactReviewResult> {
  if (!params.stories.length) {
    throw new Error("Add stories before running AI fact-check.");
  }

  const missingGrounding = params.stories.filter((s) => !s.source_notes?.trim());
  if (missingGrounding.length) {
    throw new Error(
      `Every story needs transcript grounding notes before AI fact-check (missing on position ${missingGrounding
        .map((s) => s.position)
        .join(", ")}).`
    );
  }

  const nameGate = checkIssueNames(params.issue, params.stories);
  const nameGateBlock = nameGate.ok
    ? ""
    : `
DETERMINISTIC NAME GATE (must fix — these draft names do NOT appear in transcript grounding):
${JSON.stringify(nameGate.ungrounded, null, 2)}
For each, omit the name or use a role from the transcript. Do NOT substitute a web-only spelling.
`;

  const userPrompt = `Fact-check this Ketchikan / Tongass Narrows newsletter draft.

You MUST use web_search for checkable titles, organizations, meeting outcomes, votes, dates, and places.
For PERSON NAMES: transcript grounding wins. Web may warn, but must not introduce a replacement spelling absent from the transcript.
${nameGateBlock}
Draft issue:
${JSON.stringify(
  {
    subject: params.issue.subject,
    preheader: params.issue.preheader,
    intro: params.issue.intro,
    coming_up: params.issue.coming_up,
    issue_date: params.issue.issue_date,
  },
  null,
  2
)}

Stories (source_notes include TOPIC SUMMARY + full TRANSCRIPT / SOURCE TEXT):
${JSON.stringify(params.stories.map(storyInput), null, 2)}

Search examples to run (adapt to the actual claims):
- "[role] Ketchikan" or org/meeting topic queries
- "Ketchikan [meeting/board] [topic] [year]"
- official city/borough/harbor/library pages when relevant

Return ONLY valid JSON as your final answer (after searches):
{
  "ok": true,
  "summary": "one sentence overall verdict",
  "findings": [
    {
      "severity": "error" | "warning",
      "field": "summary|title|quote|intro|subject|why_it_matters|quote_attribution|coming_up|source_notes|other",
      "story_position": 1,
      "issue": "what is wrong",
      "evidence": "short support from transcript AND/OR web (say which)",
      "suggestion": "how to fix",
      "source_url": "https://… or null"
    }
  ],
  "corrected": {
    "subject": "...",
    "preheader": "...",
    "intro": "...",
    "coming_up": ["..."],
    "stories": [
      {
        "position": 1,
        "toc_title": "...",
        "title": "...",
        "eyebrow": "...",
        "summary": "...",
        "why_it_matters": "...",
        "quote": null,
        "quote_attribution": null
      }
    ]
  }
}

Rules:
- Verify draft details against transcripts first (quotes/names must appear in source_notes TRANSCRIPT text).
- Also verify checkable non-name claims on the public web; include source_url when a web page supports or contradicts a claim.
- If web and transcript disagree on a PERSON NAME: severity "warning" for the discrepancy, and in corrected copy keep transcript spelling OR omit/use a role — never write a web-only name.
- If a name is unsupported by the transcript, severity "error" and remove/soften in corrected copy.
- Focus on names, titles/roles, orgs, votes, numbers, dates, places, and quotes.
- If ok is true and there are no errors, set corrected to null.
- If there are any errors (including name-gate items), corrected MUST include every story position with fixes applied.
- Keep the newsletter voice. Do not add new news from the web that was not in the transcript.`;

  const parsed = (await callClaudeJsonWithWebSearch({
    apiKey: params.apiKey,
    userPrompt,
    system: REVIEW_SYSTEM,
    maxTokens: 16000,
    maxSearches: 12,
  })) as {
    ok?: boolean;
    summary?: string;
    findings?: FactReviewFinding[];
    corrected?: GeneratedIssueCopy | null;
  };

  const llmFindings: FactReviewFinding[] = Array.isArray(parsed.findings)
    ? parsed.findings.map((f) => ({
        severity: f.severity === "warning" ? "warning" : "error",
        field: String(f.field ?? "other"),
        story_position:
          f.story_position == null || Number.isNaN(Number(f.story_position))
            ? null
            : Number(f.story_position),
        issue: String(f.issue ?? "").trim(),
        evidence: String(f.evidence ?? "").trim(),
        suggestion: String(f.suggestion ?? "").trim(),
        source_url: f.source_url ? String(f.source_url).trim() : null,
      }))
    : [];

  // Deterministic name findings always win — LLM cannot clear them by omission.
  const findings = [...nameGate.findings, ...llmFindings];
  const hasErrors = findings.some((f) => f.severity === "error");
  let corrected: GeneratedIssueCopy | null = null;
  if (parsed.corrected && typeof parsed.corrected === "object") {
    try {
      corrected = normalizeGenerated(parsed.corrected, params.stories);
    } catch {
      corrected = null;
    }
  }

  const ok = Boolean(parsed.ok) && !hasErrors && nameGate.ok;

  return {
    ok,
    summary:
      String(parsed.summary ?? "").trim() ||
      (ok
        ? "No factual errors found against transcripts and web sources."
        : nameGate.ok
          ? "Fact-check found issues that need correction."
          : `Name gate failed: ${nameGate.ungrounded.length} name(s) not found in transcript grounding.`),
    findings,
    corrected: ok ? null : corrected,
  };
}
