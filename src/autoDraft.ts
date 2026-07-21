import type { AppConfig } from "./config.js";
import { CLAUDE_MODEL, generateIssueFromSources } from "./claude.js";
import { createIssue, updateIssue, upsertStory } from "./db.js";
import type { GenerateResult } from "./generate.js";
import { fetchMarineConditions } from "./marine.js";
import {
  getNewestDraftSources,
  markDraftSourcesUsed,
} from "./sources.js";

export interface AutoDraftResult {
  drafted: boolean;
  reason?: string;
  findingCount: number;
  topicCount?: number;
  sourceKind?: string;
  sourceTable?: string;
  result?: GenerateResult;
}

/**
 * Analyze newest unused transcripts, refine them into digestible topics,
 * autofill Ketchikan weather/tides, and draft a review issue.
 */
export async function autoDraftFromNewestFindings(
  config: AppConfig,
  options?: { limit?: number }
): Promise<AutoDraftResult> {
  if (!config.anthropicApiKey) {
    return {
      drafted: false,
      reason:
        "Claude API key is not set. Add AI_KEY (recommended) or AI-KEY on the Railway web service, then redeploy.",
      findingCount: 0,
    };
  }

  const maxTopics = options?.limit ?? config.findingsBatchSize;
  // Load extra sources so Claude can cluster/split into topics.
  const sourceLimit = Math.max(maxTopics, 12);
  const sources = await getNewestDraftSources(config.databaseUrl, sourceLimit);
  if (sources.length === 0) {
    return {
      drafted: false,
      reason:
        "No unused transcripts (or findings) found in the database to analyze.",
      findingCount: 0,
    };
  }

  const today = new Date().toISOString().slice(0, 10);
  let marine = {
    weather: "",
    high_tides: "",
    low_tides: "",
    high_tide_label: "",
  };
  try {
    marine = await fetchMarineConditions(config, today);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`Marine autofill failed (continuing draft): ${message}`);
  }

  const issue = await createIssue(config.databaseUrl, {
    issue_date: today,
    subject: `The Ebb & Flow — draft ${today}`,
    status: "draft",
    intro: "",
    preheader: "",
    weather: marine.weather,
    high_tides: marine.high_tides,
    low_tides: marine.low_tides,
    high_tide_label: marine.high_tide_label,
  });

  try {
    const generated = await generateIssueFromSources({
      apiKey: config.anthropicApiKey,
      issue,
      sources,
      maxTopics,
    });

    const updatedIssue = await updateIssue(config.databaseUrl, issue.id, {
      subject: generated.subject,
      preheader: generated.preheader,
      intro: generated.intro,
      coming_up: generated.coming_up,
    });
    if (!updatedIssue) {
      throw new Error("Failed to save generated issue copy");
    }

    const savedStories = [] as Awaited<ReturnType<typeof upsertStory>>[];
    for (const story of generated.stories) {
      const saved = await upsertStory(config.databaseUrl, issue.id, {
        position: story.position,
        toc_title: story.toc_title || story.title.slice(0, 48),
        title: story.title,
        eyebrow: story.eyebrow || "Local",
        summary: story.summary,
        why_it_matters: story.why_it_matters,
        url: "",
        image_url: null,
        quote: story.quote,
        quote_attribution: story.quote_attribution,
        source_notes: story.source_notes || "",
        finding_id: null,
      });
      savedStories.push(saved);
    }

    await markDraftSourcesUsed(config.databaseUrl, sources, issue.id);

    return {
      drafted: true,
      findingCount: sources.length,
      topicCount: savedStories.length,
      sourceKind: sources[0]?.kind,
      sourceTable: sources[0]?.sourceTable,
      result: {
        issue: updatedIssue,
        stories: savedStories.sort((a, b) => a.position - b.position),
        model: CLAUDE_MODEL,
      },
    };
  } catch (err) {
    // Leave sources unused so a later retry can pick them up.
    throw err;
  }
}
