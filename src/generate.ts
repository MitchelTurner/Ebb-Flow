import { generateIssueCopy } from "./claude.js";
import type { AppConfig } from "./config.js";
import {
  getIssueForSend,
  getStories,
  updateIssue,
  upsertStory,
} from "./db.js";
import type { Issue, Story } from "./types.js";

export interface GenerateResult {
  issue: Issue;
  stories: Story[];
  model: string;
}

export async function generateAndSaveIssue(
  config: AppConfig,
  issueId: string
): Promise<GenerateResult> {
  if (!config.anthropicApiKey) {
    throw new Error("AI-KEY is not set");
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
    model: config.anthropicModel,
    issue,
    stories,
  });

  const updatedIssue = await updateIssue(config.databaseUrl, issueId, {
    subject: generated.subject,
    preheader: generated.preheader,
    intro: generated.intro,
    coming_up: generated.coming_up,
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
    });
    savedStories.push(saved);
  }

  return {
    issue: updatedIssue,
    stories: savedStories.sort((a, b) => a.position - b.position),
    model: config.anthropicModel,
  };
}
