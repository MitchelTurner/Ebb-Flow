import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Issue, Story, Subscriber, TemplateData } from "./types.js";

const templatePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "templates",
  "ebb-and-flow.html"
);

const TAG_RE = /\{\{(\w+)(?:\|([^}]+))?\}\}/g;

export function loadTemplate(): string {
  return readFileSync(templatePath, "utf8");
}

/** Supports `{{key}}` and `{{key|fallback}}`. */
export function renderTemplate(
  template: string,
  data: TemplateData
): string {
  return template.replace(TAG_RE, (_match, key: string, fallback?: string) => {
    const value = data[key];
    if (value !== undefined && value !== "") return value;
    if (fallback !== undefined) return fallback;
    return "";
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatIssueDateLabel(issueDate: string): string {
  // issue_date comes as YYYY-MM-DD from Postgres
  const [year, month, day] = issueDate.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function comingUpHtml(items: string[]): string {
  return items
    .map((item) => `•&nbsp; ${escapeHtml(item)}`)
    .join("<br>\n              ");
}

function splitDropcap(summary: string): { dropcap: string; rest: string } {
  const trimmed = summary.trim();
  if (!trimmed) return { dropcap: "", rest: "" };
  return {
    dropcap: escapeHtml(trimmed[0] ?? ""),
    rest: escapeHtml(trimmed.slice(1)),
  };
}

function storyByPosition(stories: Story[], position: number): Story | undefined {
  return stories.find((story) => story.position === position);
}

export function buildTemplateData(params: {
  issue: Issue;
  stories: Story[];
  subscriber: Pick<Subscriber, "first_name" | "unsubscribe_token">;
  appUrl: string;
}): TemplateData {
  const { issue, stories, subscriber, appUrl } = params;
  const first = storyByPosition(stories, 1);
  const drop = splitDropcap(first?.summary ?? "");

  const data: TemplateData = {
    email_subject: escapeHtml(issue.subject),
    preheader: escapeHtml(issue.preheader),
    view_in_browser_url: `${appUrl}/preview/${issue.id}`,
    /** Light mark on navy masthead — transparent PNG for email clients. */
    logo_url: `${appUrl}/brand/logo-mark-light-128.png`,
    issue_date_label: escapeHtml(formatIssueDateLabel(issue.issue_date)),
    volume_label: escapeHtml(issue.volume_label),
    high_tide_label: escapeHtml(issue.high_tide_label),
    weather: escapeHtml(issue.weather),
    high_tides: escapeHtml(issue.high_tides),
    low_tides: escapeHtml(issue.low_tides),
    first_name: escapeHtml(subscriber.first_name?.trim() || ""),
    intro: escapeHtml(issue.intro),
    cta_url: issue.cta_url || appUrl,
    cta_label: escapeHtml(issue.cta_label || "Read the full stories →"),
    coming_up_html: comingUpHtml(issue.coming_up ?? []),
    tip_headline: escapeHtml(issue.tip_headline),
    tip_body: escapeHtml(issue.tip_body),
    postal_address: escapeHtml(issue.postal_address),
    preferences_url: `${appUrl}/preferences/${subscriber.unsubscribe_token}`,
    unsubscribe_url: `${appUrl}/unsubscribe/${subscriber.unsubscribe_token}`,
  };

  for (let position = 1; position <= 6; position += 1) {
    const story = storyByPosition(stories, position);
    data[`story_${position}_toc_title`] = escapeHtml(story?.toc_title ?? "");
    data[`story_${position}_title`] = escapeHtml(story?.title ?? "");
    data[`story_${position}_eyebrow`] = escapeHtml(story?.eyebrow ?? "");
    data[`story_${position}_summary`] = escapeHtml(story?.summary ?? "");
    data[`story_${position}_why_it_matters`] = escapeHtml(
      story?.why_it_matters ?? ""
    );
    data[`story_${position}_url`] = story?.url || "#";

    if (position === 1) {
      data.story_1_image_url =
        story?.image_url ||
        "https://placehold.co/1040x440/e7e1d6/8a7f6d?text=Lead+photo";
      data.story_1_dropcap = drop.dropcap;
      data.story_1_summary_rest = drop.rest;
      data.story_1_quote = escapeHtml(story?.quote ?? "");
      data.story_1_quote_attribution = escapeHtml(
        story?.quote_attribution ?? ""
      );
    }
  }

  return data;
}

export function renderIssueEmail(params: {
  issue: Issue;
  stories: Story[];
  subscriber: Pick<Subscriber, "first_name" | "unsubscribe_token">;
  appUrl: string;
  template?: string;
}): string {
  const template = params.template ?? loadTemplate();
  const data = buildTemplateData(params);
  return renderTemplate(template, data);
}
