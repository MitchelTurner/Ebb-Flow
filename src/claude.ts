import Anthropic from "@anthropic-ai/sdk";
import type { RecentStoryRef } from "./dedup.js";
import type { DraftSource } from "./sources.js";
import { sourceToNotes } from "./sources.js";
import type { Issue, ProposalTopic, Story } from "./types.js";
import { randomUUID } from "node:crypto";

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

Your job is to REFINE raw meeting/interview transcripts into a small set of digestible newsletter TOPICS, then write polished copy for each topic that fits a weekly email template (up to 6 stories).`;

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
}): Promise<unknown> {
  const client = new Anthropic({ apiKey: params.apiKey });
  const response = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 16000,
    system: SYSTEM,
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
- Keep facts faithful; no invented quotes.
- Every topic needs source_notes grounding.`;

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
      "source_notes": "2-5 bullet-like lines: which source(s) this topic came from + the key facts you used"
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

  const fallbackNotes = sources.map((s) => sourceToNotes(s)).join("\n\n---\n\n");
  const rawStories = Array.isArray(parsed.stories) ? parsed.stories : [];
  const stories: GeneratedStoryCopy[] = [];

  for (const story of rawStories) {
    if (stories.length >= maxTopics) break;
    const position = stories.length + 1;
    const normalized = normalizeStory(story, position);
    if (!normalized.title) continue;
    if (!normalized.source_notes) {
      normalized.source_notes = fallbackNotes.slice(0, 8_000);
    }
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
