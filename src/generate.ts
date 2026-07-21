import {
  CLAUDE_MODEL,
  factReviewIssue,
  generateIssueCopy,
  type FactReviewResult,
  type GeneratedIssueCopy,
} from "./claude.js";
import type { AppConfig } from "./config.js";
import { loadStoriesWithContext } from "./contextFiles.js";
import {
  getIssueForSend,
  getStories,
  updateIssue,
  upsertStory,
} from "./db.js";
import { fetchMarineConditions } from "./marine.js";
import {
  checkIssueNames,
  scrubUngroundedNames,
} from "./nameCheck.js";
import type { Issue, Story } from "./types.js";

export interface GenerateResult {
  issue: Issue;
  stories: Story[];
  model: typeof CLAUDE_MODEL;
}

export type FactReviewSaveResult = FactReviewResult & {
  applied: boolean;
  issue: Issue;
  stories: Story[];
  model: typeof CLAUDE_MODEL;
  name_gate_ok: boolean;
};

function issueCopyFrom(issue: Issue, stories: Story[]): GeneratedIssueCopy {
  return {
    subject: issue.subject,
    preheader: issue.preheader,
    intro: issue.intro,
    coming_up: issue.coming_up ?? [],
    stories: stories.map((story) => ({
      position: story.position,
      toc_title: story.toc_title,
      title: story.title,
      eyebrow: story.eyebrow,
      summary: story.summary,
      why_it_matters: story.why_it_matters,
      quote: story.quote,
      quote_attribution: story.quote_attribution,
    })),
  };
}

async function saveIssueCopy(
  databaseUrl: string,
  issueId: string,
  stories: Story[],
  copy: GeneratedIssueCopy,
  factReviewedAt: string | null
): Promise<{ issue: Issue; stories: Story[] }> {
  const updatedIssue = await updateIssue(databaseUrl, issueId, {
    subject: copy.subject,
    preheader: copy.preheader,
    intro: copy.intro,
    coming_up: copy.coming_up,
    fact_reviewed_at: factReviewedAt,
  });
  if (!updatedIssue) {
    throw new Error("Failed to save issue copy");
  }

  const savedStories: Story[] = [];
  for (const story of stories) {
    const next = copy.stories.find((item) => item.position === story.position);
    if (!next) continue;
    savedStories.push(
      await upsertStory(databaseUrl, issueId, {
        id: story.id,
        position: story.position,
        toc_title: next.toc_title || story.toc_title,
        title: next.title || story.title,
        eyebrow: next.eyebrow,
        summary: next.summary,
        why_it_matters: next.why_it_matters,
        url: story.url,
        image_url: story.image_url,
        quote: next.quote,
        quote_attribution: next.quote_attribution,
        source_notes: story.source_notes,
        finding_id: story.finding_id,
      })
    );
  }

  return {
    issue: updatedIssue,
    stories: savedStories.sort((a, b) => a.position - b.position),
  };
}

export async function generateAndSaveIssue(
  config: AppConfig,
  issueId: string
): Promise<GenerateResult> {
  if (!config.anthropicApiKey) {
    throw new Error(
      "Claude API key is not set. Add AI_KEY (recommended) or AI-KEY on the Railway web service, then redeploy."
    );
  }

  const issue = await getIssueForSend(config.databaseUrl, issueId);
  if (!issue) {
    throw new Error(`Issue not found: ${issueId}`);
  }

  const stories = await getStories(config.databaseUrl, issueId);
  if (stories.length === 0) {
    throw new Error("Add story updates before generating copy.");
  }

  const groundedStories = await loadStoriesWithContext(
    config.databaseUrl,
    issueId,
    stories
  );

  const hasNotes = groundedStories.some(
    (story) =>
      (story.source_notes && story.source_notes.trim()) ||
      (story.summary && story.summary.trim()) ||
      (story.title && story.title.trim())
  );
  if (!hasNotes) {
    throw new Error(
      "Stories need source notes or uploaded context files (or at least a title/summary) for Claude to write from."
    );
  }

  const generated = await generateIssueCopy({
    apiKey: config.anthropicApiKey,
    issue,
    stories: groundedStories,
  });

  const marinePatch = await maybeAutofillMarine(config, issue);

  const updatedIssue = await updateIssue(config.databaseUrl, issueId, {
    subject: generated.subject,
    preheader: generated.preheader,
    intro: generated.intro,
    coming_up: generated.coming_up,
    fact_reviewed_at: null,
    ...marinePatch,
  });
  if (!updatedIssue) {
    throw new Error("Failed to save generated issue copy");
  }

  const savedStories: Story[] = [];
  for (const story of stories) {
    const copy = generated.stories.find((item) => item.position === story.position);
    if (!copy) continue;
    const saved = await upsertStory(config.databaseUrl, issueId, {
      id: story.id,
      position: story.position,
      toc_title: copy.toc_title || story.toc_title,
      title: copy.title || story.title,
      eyebrow: copy.eyebrow,
      summary: copy.summary,
      why_it_matters: copy.why_it_matters,
      url: story.url,
      image_url: story.image_url,
      quote: copy.quote,
      quote_attribution: copy.quote_attribution,
      source_notes: story.source_notes,
      finding_id: story.finding_id,
    });
    savedStories.push(saved);
  }

  return {
    issue: updatedIssue,
    stories: savedStories.sort((a, b) => a.position - b.position),
    model: CLAUDE_MODEL,
  };
}

/**
 * AI fact-check draft against transcript source notes + deterministic name gate.
 * Stamps fact_reviewed_at only when names pass after any applied corrections.
 */
export async function factReviewAndMaybeApply(
  config: AppConfig,
  issueId: string,
  options?: { apply?: boolean }
): Promise<FactReviewSaveResult> {
  if (!config.anthropicApiKey) {
    throw new Error(
      "Claude API key is not set. Add AI_KEY on the Railway web service, then redeploy."
    );
  }

  const issue = await getIssueForSend(config.databaseUrl, issueId);
  if (!issue) {
    throw new Error(`Issue not found: ${issueId}`);
  }
  const stories = await getStories(config.databaseUrl, issueId);
  if (!stories.length) {
    throw new Error("Add stories before running AI fact-check.");
  }

  const groundedStories = await loadStoriesWithContext(
    config.databaseUrl,
    issueId,
    stories
  );

  const review = await factReviewIssue({
    apiKey: config.anthropicApiKey,
    issue,
    stories: groundedStories,
  });

  const shouldApply =
    options?.apply === true ||
    (options?.apply !== false && Boolean(review.corrected) && !review.ok);

  let workingIssue = issue;
  let workingStories = stories;
  let applied = false;
  let findings = [...review.findings];
  let summary = review.summary;

  const withContext = async (list: Story[]) =>
    loadStoriesWithContext(config.databaseUrl, issueId, list);

  if (shouldApply) {
    let copy =
      review.corrected ?? issueCopyFrom(workingIssue, workingStories);
    const draftStories = await withContext(
      workingStories.map((story) => {
        const next = copy.stories.find((s) => s.position === story.position);
        return next
          ? {
              ...story,
              toc_title: next.toc_title || story.toc_title,
              title: next.title || story.title,
              eyebrow: next.eyebrow,
              summary: next.summary,
              why_it_matters: next.why_it_matters,
              quote: next.quote,
              quote_attribution: next.quote_attribution,
            }
          : story;
      })
    );
    const preSaveNames = checkIssueNames(
      {
        ...workingIssue,
        subject: copy.subject,
        preheader: copy.preheader,
        intro: copy.intro,
        coming_up: copy.coming_up,
      },
      draftStories
    );

    if (!preSaveNames.ok) {
      copy = scrubUngroundedNames(copy, preSaveNames.ungrounded);
      findings = [
        ...findings,
        ...preSaveNames.findings.map((f) => ({
          ...f,
          suggestion: `${f.suggestion} (auto-removed unsupported name from copy)`,
        })),
      ];
      summary = `${summary} Ungrounded names were stripped before save.`.trim();
    }

    const saved = await saveIssueCopy(
      config.databaseUrl,
      issueId,
      workingStories,
      copy,
      null
    );
    workingIssue = saved.issue;
    workingStories = saved.stories;
    applied = true;
  }

  const finalNames = checkIssueNames(
    workingIssue,
    await withContext(workingStories)
  );
  if (!finalNames.ok) {
    // Last-resort scrub on whatever is currently saved.
    const scrubbed = scrubUngroundedNames(
      issueCopyFrom(workingIssue, workingStories),
      finalNames.ungrounded
    );
    const saved = await saveIssueCopy(
      config.databaseUrl,
      issueId,
      workingStories,
      scrubbed,
      null
    );
    workingIssue = saved.issue;
    workingStories = saved.stories;
    applied = true;
    findings = [...findings, ...finalNames.findings];
    summary = `${summary} Name gate still found unsupported names; they were stripped.`.trim();
  }

  const nameGate = checkIssueNames(
    workingIssue,
    await withContext(workingStories)
  );
  // Stamp only when every person-like name is grounded. After apply/scrub, trust
  // the corrected copy for non-name LLM findings; otherwise require review.ok.
  const reviewOk = nameGate.ok && (applied || review.ok);

  if (reviewOk) {
    const stamped = await updateIssue(config.databaseUrl, issueId, {
      fact_reviewed_at: new Date().toISOString(),
    });
    workingIssue = stamped ?? workingIssue;
  } else if (workingIssue.fact_reviewed_at) {
    const cleared = await updateIssue(config.databaseUrl, issueId, {
      fact_reviewed_at: null,
    });
    workingIssue = cleared ?? workingIssue;
  }

  // Prefer surfacing any remaining name findings.
  if (!nameGate.ok) {
    for (const finding of nameGate.findings) {
      if (
        !findings.some(
          (f) =>
            f.issue === finding.issue &&
            f.story_position === finding.story_position &&
            f.field === finding.field
        )
      ) {
        findings.push(finding);
      }
    }
  }

  return {
    ok: reviewOk,
    summary:
      summary ||
      (reviewOk
        ? "Fact-check passed (transcripts, web, and name gate)."
        : "Fact-check incomplete — fix remaining errors before scheduling."),
    findings,
    corrected: review.corrected,
    applied,
    issue: workingIssue,
    stories: workingStories,
    model: CLAUDE_MODEL,
    name_gate_ok: nameGate.ok,
  };
}

/** Fill weather/tides when blank (or always when force=true). */
export async function applyMarineAutofill(
  config: AppConfig,
  issueId: string,
  options?: { force?: boolean }
): Promise<Issue> {
  const issue = await getIssueForSend(config.databaseUrl, issueId);
  if (!issue) {
    throw new Error(`Issue not found: ${issueId}`);
  }

  const force = options?.force ?? false;
  const needsFill =
    force ||
    !issue.weather?.trim() ||
    !issue.high_tides?.trim() ||
    !issue.low_tides?.trim() ||
    !issue.high_tide_label?.trim();

  if (!needsFill) return issue;

  const marine = await fetchMarineConditions(config, issue.issue_date);
  const updated = await updateIssue(config.databaseUrl, issueId, {
    weather: force || !issue.weather?.trim() ? marine.weather : issue.weather,
    high_tides:
      force || !issue.high_tides?.trim() ? marine.high_tides : issue.high_tides,
    low_tides:
      force || !issue.low_tides?.trim() ? marine.low_tides : issue.low_tides,
    high_tide_label:
      force || !issue.high_tide_label?.trim()
        ? marine.high_tide_label
        : issue.high_tide_label,
  });
  if (!updated) {
    throw new Error("Failed to save marine conditions");
  }
  return updated;
}

async function maybeAutofillMarine(
  config: AppConfig,
  issue: Issue
): Promise<Partial<Issue>> {
  const blank =
    !issue.weather?.trim() ||
    !issue.high_tides?.trim() ||
    !issue.low_tides?.trim() ||
    !issue.high_tide_label?.trim();
  if (!blank) return {};

  try {
    const marine = await fetchMarineConditions(config, issue.issue_date);
    return {
      weather: issue.weather?.trim() ? issue.weather : marine.weather,
      high_tides: issue.high_tides?.trim() ? issue.high_tides : marine.high_tides,
      low_tides: issue.low_tides?.trim() ? issue.low_tides : marine.low_tides,
      high_tide_label: issue.high_tide_label?.trim()
        ? issue.high_tide_label
        : marine.high_tide_label,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`Marine autofill skipped: ${message}`);
    return {};
  }
}
