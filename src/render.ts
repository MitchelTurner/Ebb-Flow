import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveTemplatesDir } from "./assetPaths.js";
import {
  brandLogoUrl,
  type LogoDelivery,
} from "./brandAssets.js";
import type { Issue, Story, Subscriber, TemplateData } from "./types.js";

const templatePath = join(resolveTemplatesDir(), "ebb-and-flow.html");

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

function storyHasContent(story: Story | undefined): boolean {
  if (!story) return false;
  return Boolean(
    story.title?.trim() ||
      story.toc_title?.trim() ||
      story.summary?.trim()
  );
}

/** Lead image markup — empty when no hosted image URL is set. */
export function buildLeadImageHtml(params: {
  imageUrl: string | null | undefined;
  title: string;
  url: string;
}): string {
  const imageUrl = params.imageUrl?.trim();
  if (!imageUrl) return "";
  const href = params.url || "#";
  const alt = escapeHtml(params.title || "Lead photo");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tbody><tr>
          <td align="center" valign="middle" style="background-color:#e7e1d6; border:1px solid #d8d2c8;">
            <a href="${href}" style="text-decoration:none;">
              <img src="${escapeHtml(imageUrl)}" width="520" alt="${alt}" style="display:block; width:100%; max-width:520px; height:auto; border:0;">
            </a>
          </td>
        </tr>
      </tbody></table>`;
}

/** Pull-quote markup — empty when quote text is missing. */
export function buildQuoteHtml(params: {
  quote: string | null | undefined;
  attribution: string | null | undefined;
}): string {
  const quote = params.quote?.trim();
  if (!quote) return "";
  const attribution = params.attribution?.trim();
  const attrHtml = attribution
    ? `<br><span style="font-family:'Helvetica Neue',Arial,sans-serif; font-size:11px; font-style:normal; color:#7a8a99; letter-spacing:1.5px; text-transform:uppercase;">— ${escapeHtml(attribution)}</span>`
    : "";
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:18px;">
          <tbody><tr><td style="border-left:3px solid #b8975a; padding:2px 0 2px 18px; font-family:Georgia,serif; font-size:18px; line-height:27px; font-style:italic; color:#16293a;">“${escapeHtml(quote)}”${attrHtml}</td></tr>
        </tbody></table>`;
}

function padTocNum(n: number): string {
  return String(n).padStart(2, "0");
}

/** TOC lines only for stories that have content. */
export function buildTocHtml(stories: Story[]): string {
  const lines: string[] = [];
  let ordinal = 0;
  for (let position = 1; position <= 6; position += 1) {
    const story = storyByPosition(stories, position);
    if (!storyHasContent(story)) continue;
    ordinal += 1;
    const title = escapeHtml(
      story!.toc_title?.trim() || story!.title?.trim() || `Story ${position}`
    );
    lines.push(
      `<a href="#story${position}" style="color:#3a352e; text-decoration:none;">${padTocNum(ordinal)} &nbsp;${title}</a>`
    );
  }
  return lines.join("<br>\n              ");
}

function buildStory1SectionHtml(story: Story | undefined): string {
  if (!storyHasContent(story)) return "";
  const drop = splitDropcap(story!.summary ?? "");
  const imageHtml = buildLeadImageHtml({
    imageUrl: story!.image_url,
    title: story!.title ?? "",
    url: story!.url || "#",
  });
  const quoteHtml = buildQuoteHtml({
    quote: story!.quote,
    attribution: story!.quote_attribution,
  });
  return `<tr>
    <td class="px" style="padding:30px 40px 0 40px;" id="story1">
      <div style="font-family:'Helvetica Neue',Arial,sans-serif; font-size:11px; letter-spacing:2px; text-transform:uppercase; color:#a07d2f; font-weight:bold; padding-bottom:14px;">${escapeHtml(story!.eyebrow ?? "")}</div>
      ${imageHtml}
      <div style="padding-top:18px;">
        <a href="${story!.url || "#"}" class="hero-title" style="font-family:Georgia,serif; font-size:30px; line-height:36px; color:#1a1a1a; font-weight:bold; text-decoration:none;">${escapeHtml(story!.title ?? "")}</a>
        <div style="font-family:Georgia,serif; font-size:16px; line-height:26px; color:#5a544a; padding-top:10px;"><span style="float:left; font-family:Georgia,serif; font-size:52px; line-height:40px; color:#16293a; font-weight:bold; padding:4px 8px 0 0;">${drop.dropcap}</span>${drop.rest}</div>
        ${quoteHtml}
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:16px;">
          <tbody><tr>
            <td valign="top" style="font-family:'Helvetica Neue',Arial,sans-serif; font-size:11px; letter-spacing:1px; text-transform:uppercase; line-height:20px; color:#16293a; font-weight:bold; white-space:nowrap; padding-right:8px;">Why it matters:</td>
            <td valign="top" style="font-family:Georgia,serif; font-size:13px; line-height:20px; color:#5a544a;">${escapeHtml(story!.why_it_matters ?? "")}</td>
          </tr>
        </tbody></table>
      </div>
    </td>
  </tr>`;
}

function buildSecondaryStoryRowHtml(
  story: Story,
  displayNum: string,
  isLast: boolean
): string {
  const padding = isLast
    ? "padding:22px 40px 26px 40px;"
    : "padding:22px 40px 22px 40px; border-bottom:1px solid #ede9e1;";
  return `<tr>
    <td class="px" style="${padding}" id="story${story.position}">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tbody><tr>
          <td valign="top" width="34" style="font-family:Georgia,serif; font-size:30px; line-height:30px; color:#b8975a; font-weight:bold;">${displayNum}</td>
          <td valign="top" style="padding-left:14px;">
            <div style="font-family:'Helvetica Neue',Arial,sans-serif; font-size:10px; letter-spacing:2px; text-transform:uppercase; color:#a07d2f; font-weight:bold; padding-bottom:5px;">${escapeHtml(story.eyebrow ?? "")}</div>
            <a href="${story.url || "#"}" style="font-family:Georgia,serif; font-size:21px; line-height:27px; color:#1a1a1a; font-weight:bold; text-decoration:none;">${escapeHtml(story.title ?? "")}</a>
            <div style="font-family:Georgia,serif; font-size:15px; line-height:24px; color:#5a544a; padding-top:6px;">${escapeHtml(story.summary ?? "")}</div>
            <div style="font-family:Georgia,serif; font-size:13px; line-height:20px; color:#16293a; padding-top:8px;"><strong style="letter-spacing:0.4px;">Why it matters:</strong> <span style="color:#5a544a;">${escapeHtml(story.why_it_matters ?? "")}</span></div>
          </td>
        </tr>
      </tbody></table>
    </td>
  </tr>`;
}

/** “More Headlines” label + story rows 2–6 that have content. */
export function buildMoreHeadlinesHtml(stories: Story[]): string {
  const secondary = [2, 3, 4, 5, 6]
    .map((position) => storyByPosition(stories, position))
    .filter((story): story is Story => storyHasContent(story));
  if (!secondary.length) return "";

  const label = `<tr>
    <td class="px" style="padding:30px 40px 0 40px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tbody><tr>
          <td style="font-family:'Helvetica Neue',Arial,sans-serif; font-size:12px; letter-spacing:2px; text-transform:uppercase; color:#16293a; font-weight:bold; white-space:nowrap; padding-right:14px;">More Headlines</td>
          <td width="100%" style="border-bottom:1px solid #d8c9a8; font-size:1px; line-height:1px;">&nbsp;</td>
        </tr>
      </tbody></table>
    </td>
  </tr>`;

  const rows = secondary
    .map((story, index) =>
      buildSecondaryStoryRowHtml(
        story,
        padTocNum(index + 2),
        index === secondary.length - 1
      )
    )
    .join("\n");

  return `${label}\n${rows}`;
}

export type EmailViewMode = "subscriber" | "public";

export function buildTemplateData(params: {
  issue: Issue;
  stories: Story[];
  subscriber: Pick<Subscriber, "first_name" | "unsubscribe_token">;
  appUrl: string;
  /** How to reference the masthead logo. Default: hosted via APP_URL. */
  logoDelivery?: LogoDelivery;
  /**
   * subscriber = real prefs/unsub tokens (live + preview emails).
   * public = archive/browser view — no fake unsubscribe tokens.
   */
  viewMode?: EmailViewMode;
}): TemplateData {
  const { issue, stories, subscriber, appUrl } = params;
  const logoDelivery = params.logoDelivery ?? "hosted";
  const viewMode = params.viewMode ?? "subscriber";
  const first = storyByPosition(stories, 1);
  const drop = splitDropcap(first?.summary ?? "");

  const archiveUrl = `${appUrl}/archive/${issue.id}`;
  const previewUrl = `${appUrl}/preview/${issue.id}`;
  const viewInBrowserUrl =
    viewMode === "public" && issue.status === "sent" ? archiveUrl : previewUrl;

  let preferences_url: string;
  let unsubscribe_url: string;
  let preferences_label: string;
  let unsubscribe_label: string;

  if (viewMode === "public") {
    preferences_url = `${appUrl}/`;
    unsubscribe_url = `${appUrl}/archive`;
    preferences_label = "Subscribe";
    unsubscribe_label = "Archive";
  } else {
    preferences_url = `${appUrl}/preferences/${subscriber.unsubscribe_token}`;
    unsubscribe_url = `${appUrl}/unsubscribe/${subscriber.unsubscribe_token}`;
    preferences_label = "Update preferences";
    unsubscribe_label = "Unsubscribe";
  }

  const data: TemplateData = {
    email_subject: escapeHtml(issue.subject),
    preheader: escapeHtml(issue.preheader),
    view_in_browser_url: viewInBrowserUrl,
    /** Light mark on navy masthead — CID for sends, relative for in-app preview. */
    logo_url: brandLogoUrl(logoDelivery, appUrl),
    issue_date_label: escapeHtml(formatIssueDateLabel(issue.issue_date)),
    volume_label: escapeHtml(issue.volume_label),
    high_tide_label: escapeHtml(issue.high_tide_label),
    weather: escapeHtml(issue.weather),
    high_tides: escapeHtml(issue.high_tides),
    low_tides: escapeHtml(issue.low_tides),
    first_name: escapeHtml(subscriber.first_name?.trim() || ""),
    intro: escapeHtml(issue.intro),
    cta_url: "",
    cta_label: "",
    coming_up_html: comingUpHtml(issue.coming_up ?? []),
    tip_headline: escapeHtml(issue.tip_headline),
    tip_body: escapeHtml(issue.tip_body),
    postal_address: escapeHtml(issue.postal_address),
    preferences_url,
    unsubscribe_url,
    preferences_label,
    unsubscribe_label,
    toc_html: buildTocHtml(stories),
    story_1_section_html: buildStory1SectionHtml(first),
    more_headlines_html: buildMoreHeadlinesHtml(stories),
  };

  // Keep legacy per-slot keys for any external callers / partial templates.
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
      data.story_1_image_url = story?.image_url?.trim() || "";
      data.story_1_image_html = buildLeadImageHtml({
        imageUrl: story?.image_url,
        title: story?.title ?? "",
        url: story?.url || "#",
      });
      data.story_1_dropcap = drop.dropcap;
      data.story_1_summary_rest = drop.rest;
      data.story_1_quote = escapeHtml(story?.quote ?? "");
      data.story_1_quote_attribution = escapeHtml(
        story?.quote_attribution ?? ""
      );
      data.story_1_quote_html = buildQuoteHtml({
        quote: story?.quote,
        attribution: story?.quote_attribution,
      });
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
  logoDelivery?: LogoDelivery;
  viewMode?: EmailViewMode;
}): string {
  const template = params.template ?? loadTemplate();
  const data = buildTemplateData(params);
  return renderTemplate(template, data);
}
