import {
  CLAUDE_MODEL,
  factReviewIssue,
  generateIssueCopy,
  type FactReviewResult,
} from "./claude.js";
import type { AppConfig } from "./config.js";
import {
  getIssueForSend,
  getStories,
  updateIssue,
  upsertStory,
} from "./db.js";
import { fetchMarineConditions } from "./marine.js";
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
};

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

  const hasNotes = stories.some(
    (story) =>
      (story.source_notes && story.source_notes.trim()) ||
      (story.summary && story.summary.trim()) ||
      (story.title && story.title.trim())
  );
  if (!hasNotes) {
    throw new Error(
      "Stories need source notes (or at least a title/summary) for Claude to write from."
    );
  }

  const generated = await generateIssueCopy({
    apiKey: config.anthropicApiKey,
    issue,
    stories,
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
 * AI fact-check draft against transcript source notes.
 * When apply=true (default if errors + corrections exist), saves the corrected copy.
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

  const review = await factReviewIssue({
    apiKey: config.anthropicApiKey,
    issue,
    stories,
  });

  const shouldApply =
    options?.apply === true ||
    (options?.apply !== false && Boolean(review.corrected) && !review.ok);

  if (!shouldApply || !review.corrected) {
    const stamped =
      review.ok
        ? await updateIssue(config.databaseUrl, issueId, {
            fact_reviewed_at: new Date().toISOString(),
          })
        : issue;
    return {
      ...review,
      applied: false,
      issue: stamped ?? issue,
      stories,
      model: CLAUDE_MODEL,
    };
  }

  const corrected = review.corrected;
  const updatedIssue = await updateIssue(config.databaseUrl, issueId, {
    subject: corrected.subject,
    preheader: corrected.preheader,
    intro: corrected.intro,
    coming_up: corrected.coming_up,
    fact_reviewed_at: new Date().toISOString(),
  });
  if (!updatedIssue) {
    throw new Error("Failed to save fact-check corrections");
  }

  const savedStories: Story[] = [];
  for (const story of stories) {
    const copy = corrected.stories.find((item) => item.position === story.position);
    if (!copy) continue;
    savedStories.push(
      await upsertStory(config.databaseUrl, issueId, {
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
      })
    );
  }

  return {
    ...review,
    applied: true,
    issue: updatedIssue,
    stories: savedStories.sort((a, b) => a.position - b.position),
    model: CLAUDE_MODEL,
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
