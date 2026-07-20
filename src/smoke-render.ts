/**
 * Offline smoke test: render the template with fixture data (no database).
 * Run: npx tsx src/smoke-render.ts
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderIssueEmail, renderTemplate } from "./render.js";
import type { Issue, Story } from "./types.js";

assert.equal(
  renderTemplate("Hi {{first_name|neighbor}}", { first_name: "" }),
  "Hi neighbor"
);
assert.equal(
  renderTemplate("Hi {{first_name|neighbor}}", { first_name: "Alex" }),
  "Hi Alex"
);

const issue: Issue = {
  id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  issue_date: "2026-07-19",
  volume_label: "Vol. 4, No. 29",
  subject: "The Ebb & Flow — July 19, 2026",
  preheader: "This week in town.",
  intro: "Six stories worth your time this week.",
  weather: "54°F · Light Rain",
  high_tides: "6:12a · 5:48p",
  low_tides: "12:03p · 11:41p",
  high_tide_label: "High tide 6:12 a.m.",
  coming_up: ["Item one", "Item two"],
  cta_url: "https://example.com",
  cta_label: "Read the full stories →",
  tip_headline: "Got a tip?",
  tip_body: "Just hit reply.",
  postal_address: "123 Main Street",
  status: "ready",
};

const stories: Story[] = [1, 2, 3, 4, 5, 6].map((position) => ({
  id: `00000000-0000-0000-0000-00000000000${position}`,
  issue_id: issue.id,
  position,
  toc_title: `Story ${position} toc`,
  title: `Story ${position} title`,
  eyebrow: `Section ${position}`,
  summary: `Summary for story ${position} with enough text.`,
  why_it_matters: `Why ${position} matters.`,
  url: `https://example.com/story-${position}`,
  image_url:
    position === 1
      ? "https://placehold.co/1040x440/e7e1d6/8a7f6d?text=Lead+photo"
      : null,
  quote: position === 1 ? "A memorable quote." : null,
  quote_attribution: position === 1 ? "Someone Notable" : null,
}));

const html = renderIssueEmail({
  issue,
  stories,
  subscriber: { first_name: "Alex", unsubscribe_token: "tok" },
  appUrl: "http://localhost:3000",
});

assert.match(html, /Good morning, Alex\./);
assert.match(html, /Story 1 title/);
assert.match(html, /unsubscribe\/tok/);
assert.doesNotMatch(html, /\{\{[a-z0-9_|]+\}\}/i);

mkdirSync(".preview", { recursive: true });
const out = join(".preview", "smoke.html");
writeFileSync(out, html, "utf8");
console.log(`Smoke render OK → ${out} (${html.length} bytes)`);
