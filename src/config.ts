import "dotenv/config";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function bool(name: string, fallback = false): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value);
}

export function getConfig() {
  return {
    databaseUrl: required("DATABASE_URL"),
    resendApiKey: optional("RESEND_API_KEY"),
    fromEmail: optional("FROM_EMAIL") ?? "The Ebb & Flow <onboarding@resend.dev>",
    appUrl: (optional("APP_URL") ?? "http://localhost:3000").replace(/\/$/, ""),
    adminPassword: optional("ADMIN_PASSWORD"),
    anthropicApiKey: optional("ANTHROPIC_API_KEY"),
    anthropicModel:
      optional("ANTHROPIC_MODEL") ?? "claude-sonnet-4-20250514",
    /** When true, saving a story with source_notes triggers Claude rewrite of that issue. */
    anthropicAutoWrite: bool("ANTHROPIC_AUTO_WRITE", false),
    issueId: optional("ISSUE_ID"),
    dryRun: bool("DRY_RUN", false),
    maxRecipients: process.env.MAX_RECIPIENTS
      ? Number.parseInt(process.env.MAX_RECIPIENTS, 10)
      : undefined,
    port: Number.parseInt(process.env.PORT ?? "3000", 10),
  };
}

export type AppConfig = ReturnType<typeof getConfig>;
