import type { AppConfig } from "./config.js";
import { createIssue, upsertStory } from "./db.js";
import { generateAndSaveIssue, type GenerateResult } from "./generate.js";
import {
  getNewestDraftSources,
  markDraftSourcesUsed,
  sourceToNotes,
  type DraftSource,
} from "./sources.js";

export interface AutoDraftResult {
  drafted: boolean;
  reason?: string;
  findingCount: number;
  sourceKind?: string;
  sourceTable?: string;
  result?: GenerateResult;
}

/**
 * Analyze the newest unused transcripts (or findings fallback) from Postgres,
 * create a draft issue, and ask Claude Fable 5 to fill the email template.
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

  const limit = options?.limit ?? config.findingsBatchSize;
  const sources = await getNewestDraftSources(config.databaseUrl, limit);
  if (sources.length === 0) {
    return {
      drafted: false,
      reason:
        "No unused transcripts (or findings) found in the database to analyze.",
      findingCount: 0,
    };
  }

  const today = new Date().toISOString().slice(0, 10);
  const issue = await createIssue(config.databaseUrl, {
    issue_date: today,
    subject: `The Ebb & Flow — draft ${today}`,
    status: "draft",
    intro: "",
    preheader: "",
  });

  const batch = sources.slice(0, 6);
  let position = 1;
  for (const source of batch) {
    await upsertStory(config.databaseUrl, issue.id, {
      position,
      toc_title: stubTitle(source, position),
      title: stubTitle(source, position),
      eyebrow: source.category || "Transcript",
      summary: "",
      why_it_matters: "",
      url: source.url || "",
      image_url: null,
      quote: null,
      quote_attribution: null,
      source_notes: sourceToNotes(source),
      finding_id: source.kind === "finding" ? source.id : null,
    });
    position += 1;
  }

  try {
    const result = await generateAndSaveIssue(config, issue.id);
    await markDraftSourcesUsed(config.databaseUrl, batch, issue.id);
    return {
      drafted: true,
      findingCount: batch.length,
      sourceKind: batch[0]?.kind,
      sourceTable: batch[0]?.sourceTable,
      result,
    };
  } catch (err) {
    // Leave sources unused so a later retry can pick them up.
    throw err;
  }
}

function stubTitle(source: DraftSource, position: number): string {
  const title = source.title.trim();
  if (title) return title.slice(0, 80);
  const firstLine = source.content.trim().split(/\n/)[0] ?? "";
  return firstLine.slice(0, 80) || `Transcript ${position}`;
}
