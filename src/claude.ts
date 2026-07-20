import Anthropic from "@anthropic-ai/sdk";
import type { Issue, Story } from "./types.js";

export interface GeneratedStoryCopy {
  position: number;
  toc_title: string;
  title: string;
  eyebrow: string;
  summary: string;
  why_it_matters: string;
  quote: string | null;
  quote_attribution: string | null;
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

You rewrite rough story notes into polished newsletter copy that fits a 6-story weekly email.`;

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

export async function generateIssueCopy(params: {
  apiKey: string;
  model: string;
  issue: Issue;
  stories: Story[];
}): Promise<GeneratedIssueCopy> {
  if (!params.stories.length) {
    throw new Error("Add at least one story (with source notes) before generating.");
  }

  const client = new Anthropic({ apiKey: params.apiKey });
  const userPrompt = `Rewrite this week's issue from the database story updates below.

Issue date: ${params.issue.issue_date}
Volume label: ${params.issue.volume_label || "(none)"}
Current subject: ${params.issue.subject}

Stories (prefer source_notes when present; otherwise polish existing fields):
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
      "summary": "2-3 sentences",
      "why_it_matters": "one short sentence",
      "quote": "optional quote text without surrounding quotation marks, or null",
      "quote_attribution": "optional attribution without leading em dash, or null"
    }
  ]
}

Rules:
- Include every input story position in the output.
- Position 1 is the lead story and should be the strongest.
- Keep facts faithful to the notes; do not invent votes, names, dates, or quotes.
- If a quote is not supported by the notes, set quote and quote_attribution to null.
- coming_up should be 2-4 short teaser bullets for next week.`;

  const response = await client.messages.create({
    model: params.model,
    max_tokens: 4096,
    system: SYSTEM,
    messages: [{ role: "user", content: userPrompt }],
  });

  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();

  if (!text) {
    throw new Error("Claude returned an empty response");
  }

  const parsed = extractJson(text) as GeneratedIssueCopy;
  return normalizeGenerated(parsed, params.stories);
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
    storiesByPosition.set(position, {
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
    });
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
