import type { FactReviewFinding, Issue, Story } from "./types.js";
import type { DraftSource } from "./sources.js";
import { sourceToNotes } from "./sources.js";

export type NameHit = {
  name: string;
  field: string;
  story_position: number | null;
};

export type NameCheckResult = {
  ok: boolean;
  ungrounded: NameHit[];
  findings: FactReviewFinding[];
};

/** Phrases that look capitalized but are not person names we need to gate. */
const IGNORE_EXACT = new Set(
  [
    "the ebb",
    "ebb flow",
    "tongass narrows",
    "southeast alaska",
    "city council",
    "borough assembly",
    "planning commission",
    "harbor department",
    "school board",
    "chamber of commerce",
    "united states",
    "new york",
    "good morning",
    "high tide",
    "low tide",
    "coming up",
  ].map((s) => s.toLowerCase())
);

const IGNORE_TOKEN = new Set(
  [
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
    "alaska",
    "ketchikan",
    "tongass",
    "narrows",
    "southeast",
    "pacific",
    "america",
    "american",
    "council",
    "assembly",
    "commission",
    "department",
    "district",
    "borough",
    "city",
    "harbor",
    "harbour",
    "library",
    "school",
    "board",
    "mayor",
    "manager",
    "director",
    "chair",
    "chairman",
    "chairwoman",
    "councilmember",
    "councilman",
    "councilwoman",
    "assemblymember",
    "commissioner",
    "president",
    "senator",
    "representative",
    "governor",
    "officer",
    "captain",
    "chief",
    "doctor",
    "dr",
    "mr",
    "mrs",
    "ms",
    "miss",
    "jr",
    "sr",
    "ii",
    "iii",
    "iv",
    "member",
    "the",
    "and",
    "of",
    "for",
    "from",
    "with",
    "near",
    "local",
    "weekly",
    "newsletter",
    "update",
    "meeting",
    "agenda",
    "minutes",
    "vote",
    "motion",
    "public",
    "comment",
    "north",
    "south",
    "east",
    "west",
  ].map((s) => s.toLowerCase())
);

const NAME_RE =
  /\b([A-Z][a-z]+(?:['’-][A-Z]?[a-z]+)*(?:\s+[A-Z]\.)?(?:\s+[A-Z][a-z]+(?:['’-][A-Z]?[a-z]+)*){1,3})\b/g;

function normalizeSpace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function fold(text: string): string {
  return normalizeSpace(text)
    .toLowerCase()
    .replace(/['’]/g, "'")
    .replace(/[.]/g, "");
}

function isIgnoredName(name: string): boolean {
  const folded = fold(name);
  if (IGNORE_EXACT.has(folded)) return true;
  const parts = folded.split(" ").filter(Boolean);
  if (parts.length < 2) return true;
  if (parts.every((p) => IGNORE_TOKEN.has(p))) return true;
  // Require at least one token that isn't a role/place word.
  const meaningful = parts.filter((p) => !IGNORE_TOKEN.has(p) && p.length > 1);
  return meaningful.length === 0;
}

function stripRoleWords(name: string): string {
  let parts = normalizeSpace(name).split(/\s+/).filter(Boolean);
  while (parts.length && IGNORE_TOKEN.has(parts[0].toLowerCase().replace(/\./g, ""))) {
    parts = parts.slice(1);
  }
  while (
    parts.length &&
    IGNORE_TOKEN.has(parts[parts.length - 1].toLowerCase().replace(/\./g, ""))
  ) {
    parts = parts.slice(0, -1);
  }
  return parts.join(" ");
}

/** Extract person-like proper names from newsletter copy. */
export function extractProperNames(text: string): string[] {
  if (!text?.trim()) return [];
  const found = new Map<string, string>();
  for (const match of text.matchAll(NAME_RE)) {
    const raw = stripRoleWords(match[1] ?? "");
    if (!raw || isIgnoredName(raw)) continue;
    const key = fold(raw);
    if (!found.has(key)) found.set(key, raw);
  }
  return [...found.values()];
}

export function nameAppearsInGrounding(name: string, grounding: string): boolean {
  const hay = fold(grounding);
  if (!hay) return false;
  const needle = fold(name);
  if (!needle) return false;
  if (hay.includes(needle)) return true;

  // Allow first + last when a middle name/initial is present in only one side.
  const parts = needle.split(" ").filter(Boolean);
  if (parts.length >= 2) {
    const first = parts[0];
    const last = parts[parts.length - 1];
    if (
      first.length > 1 &&
      last.length > 1 &&
      !IGNORE_TOKEN.has(first) &&
      !IGNORE_TOKEN.has(last)
    ) {
      const loose = new RegExp(
        `\\b${escapeRegExp(first)}\\b[\\s\\S]{0,40}?\\b${escapeRegExp(last)}\\b`,
        "i"
      );
      if (loose.test(hay)) return true;
    }
  }
  return false;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collectFromField(
  value: string | null | undefined,
  field: string,
  storyPosition: number | null,
  into: NameHit[]
): void {
  for (const name of extractProperNames(value ?? "")) {
    into.push({ name, field, story_position: storyPosition });
  }
}

/** Build durable grounding: short topic summary + raw transcript text. */
export function buildStoryGroundingNotes(
  topicSummary: string | undefined,
  sources: DraftSource[]
): string {
  const raw = sources.map((s) => sourceToNotes(s)).join("\n\n---\n\n");
  const summary = (topicSummary ?? "").trim();
  if (!summary) return raw;
  if (summary.includes("TRANSCRIPT / SOURCE TEXT:")) return summary;
  if (!raw) return summary;
  return `TOPIC SUMMARY:\n${summary}\n\n---\n\n${raw}`;
}

export function collectDraftNameHits(issue: Issue, stories: Story[]): NameHit[] {
  const hits: NameHit[] = [];
  collectFromField(issue.subject, "subject", null, hits);
  collectFromField(issue.preheader, "preheader", null, hits);
  collectFromField(issue.intro, "intro", null, hits);
  for (const line of issue.coming_up ?? []) {
    collectFromField(line, "coming_up", null, hits);
  }

  for (const story of stories) {
    const pos = story.position;
    collectFromField(story.title, "title", pos, hits);
    collectFromField(story.toc_title, "toc_title", pos, hits);
    collectFromField(story.eyebrow, "eyebrow", pos, hits);
    collectFromField(story.summary, "summary", pos, hits);
    collectFromField(story.why_it_matters, "why_it_matters", pos, hits);
    collectFromField(story.quote, "quote", pos, hits);
    if (story.quote_attribution?.trim()) {
      // Attribution is always treated as a name/role string.
      const attr = normalizeSpace(story.quote_attribution);
      if (!isIgnoredName(attr) || extractProperNames(attr).length) {
        for (const name of extractProperNames(attr)) {
          hits.push({ name, field: "quote_attribution", story_position: pos });
        }
        // Also check the full attribution when it looks like "First Last, title"
        const firstLast = attr.split(",")[0]?.trim();
        if (firstLast && extractProperNames(firstLast).length === 0 && /[A-Z]/.test(firstLast)) {
          const parts = firstLast.split(/\s+/);
          if (parts.length >= 2 && !isIgnoredName(firstLast)) {
            hits.push({
              name: firstLast,
              field: "quote_attribution",
              story_position: pos,
            });
          }
        }
      }
    }
  }

  // Dedupe by name+field+position
  const seen = new Set<string>();
  return hits.filter((hit) => {
    const key = `${fold(hit.name)}|${hit.field}|${hit.story_position ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function groundingForHit(hit: NameHit, stories: Story[]): string {
  if (hit.story_position == null) {
    return stories.map((s) => s.source_notes || "").join("\n\n");
  }
  const story = stories.find((s) => s.position === hit.story_position);
  if (story?.source_notes?.trim()) return story.source_notes;
  return stories.map((s) => s.source_notes || "").join("\n\n");
}

/** Deterministic gate: every person-like name in the draft must appear in grounding. */
export function checkIssueNames(issue: Issue, stories: Story[]): NameCheckResult {
  const ungrounded: NameHit[] = [];
  for (const hit of collectDraftNameHits(issue, stories)) {
    const grounding = groundingForHit(hit, stories);
    if (!nameAppearsInGrounding(hit.name, grounding)) {
      ungrounded.push(hit);
    }
  }

  const findings: FactReviewFinding[] = ungrounded.map((hit) => ({
    severity: "error",
    field: hit.field,
    story_position: hit.story_position,
    issue: `Name "${hit.name}" does not appear in the transcript/source grounding.`,
    evidence:
      "Deterministic name gate: draft names must match the attached transcript text exactly (or as first+last).",
    suggestion: `Remove "${hit.name}", replace with a role/title from the transcript, or fix the spelling to match the source.`,
    source_url: null,
  }));

  return {
    ok: ungrounded.length === 0,
    ungrounded,
    findings,
  };
}

/** Remove ungrounded full-name strings from copy (last-resort scrub before save). */
export function scrubUngroundedNames<T extends {
  subject: string;
  preheader: string;
  intro: string;
  coming_up: string[];
  stories: Array<{
    position: number;
    toc_title: string;
    title: string;
    eyebrow: string;
    summary: string;
    why_it_matters: string;
    quote: string | null;
    quote_attribution: string | null;
  }>;
}>(copy: T, ungrounded: NameHit[]): T {
  if (!ungrounded.length) return copy;

  const byField = (field: string, storyPosition: number | null) =>
    ungrounded
      .filter(
        (h) =>
          h.field === field &&
          (storyPosition == null
            ? h.story_position == null
            : h.story_position === storyPosition)
      )
      .map((h) => h.name);

  const scrub = (text: string, names: string[]): string => {
    let out = text;
    for (const name of names) {
      out = out.replace(new RegExp(escapeRegExp(name), "gi"), "").replace(/\s{2,}/g, " ");
      out = out.replace(/\s+([,.;:])/g, "$1").replace(/\(\s*\)/g, "").trim();
    }
    return out;
  };

  return {
    ...copy,
    subject: scrub(copy.subject, byField("subject", null)),
    preheader: scrub(copy.preheader, byField("preheader", null)),
    intro: scrub(copy.intro, byField("intro", null)),
    coming_up: copy.coming_up.map((line) => scrub(line, byField("coming_up", null))),
    stories: copy.stories.map((story) => ({
      ...story,
      toc_title: scrub(story.toc_title, byField("toc_title", story.position)),
      title: scrub(story.title, byField("title", story.position)),
      eyebrow: scrub(story.eyebrow, byField("eyebrow", story.position)),
      summary: scrub(story.summary, byField("summary", story.position)),
      why_it_matters: scrub(
        story.why_it_matters,
        byField("why_it_matters", story.position)
      ),
      quote: story.quote
        ? scrub(story.quote, byField("quote", story.position)) || null
        : null,
      quote_attribution: (() => {
        const names = byField("quote_attribution", story.position);
        if (!story.quote_attribution) return null;
        if (!names.length) return story.quote_attribution;
        const cleaned = scrub(story.quote_attribution, names);
        return cleaned || null;
      })(),
    })),
  };
}
