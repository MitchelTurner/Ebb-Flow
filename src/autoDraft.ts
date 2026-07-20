import type { AppConfig } from "./config.js";
import {
  createIssue,
  getNewestUnusedFindings,
  markFindingsUsed,
  upsertStory,
} from "./db.js";
import { generateAndSaveIssue, type GenerateResult } from "./generate.js";
import type { Finding } from "./types.js";

export interface AutoDraftResult {
  drafted: boolean;
  reason?: string;
  findingCount: number;
  result?: GenerateResult;
}

/**
 * Pull the newest unused findings from Postgres, create a draft issue,
 * and ask Claude Fable 5 to write the newsletter for admin review.
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
  const findings = await getNewestUnusedFindings(config.databaseUrl, limit);
  if (findings.length === 0) {
    return {
      drafted: false,
      reason: "No unused findings to draft from",
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

  const batch = findings.slice(0, 6);
  let position = 1;
  for (const finding of batch) {
    await upsertStory(config.databaseUrl, issue.id, {
      position,
      toc_title: stubTitle(finding, position),
      title: stubTitle(finding, position),
      eyebrow: finding.category || "Local",
      summary: "",
      why_it_matters: "",
      url: finding.source_url || "",
      image_url: null,
      quote: null,
      quote_attribution: null,
      source_notes: findingToNotes(finding),
      finding_id: finding.id,
    });
    position += 1;
  }

  try {
    const result = await generateAndSaveIssue(config, issue.id);
    await markFindingsUsed(
      config.databaseUrl,
      batch.map((f) => f.id),
      issue.id
    );
    return {
      drafted: true,
      findingCount: batch.length,
      result,
    };
  } catch (err) {
    // Leave findings unused so a later retry can pick them up.
    throw err;
  }
}

function stubTitle(finding: Finding, position: number): string {
  const title = finding.title.trim();
  if (title) return title.slice(0, 80);
  const firstLine = finding.body.trim().split(/\n/)[0] ?? "";
  return firstLine.slice(0, 80) || `Finding ${position}`;
}

function findingToNotes(finding: Finding): string {
  const parts = [
    finding.title.trim() ? `Title: ${finding.title.trim()}` : "",
    finding.category.trim() ? `Category: ${finding.category.trim()}` : "",
    finding.source_url.trim() ? `Source: ${finding.source_url.trim()}` : "",
    finding.found_at ? `Found at: ${finding.found_at}` : "",
    "",
    finding.body.trim(),
  ];
  return parts.filter((line, idx) => line || idx === parts.length - 1).join("\n");
}
