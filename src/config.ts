import "dotenv/config";

function required(name: string): string {
  const value = readEnv(name);
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string): string | undefined {
  return readEnv(name);
}

/** Read env values, trimming whitespace and surrounding quotes. */
function readEnv(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === null) return undefined;
  let value = String(raw).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1).trim();
  }
  return value || undefined;
}

/**
 * Claude / Anthropic key aliases.
 * Prefer AI_KEY (underscore) — some hosts mishandle hyphenated names like AI-KEY.
 */
export const AI_KEY_ENV_NAMES = [
  "AI_KEY",
  "AI-KEY",
  "ANTHROPIC_API_KEY",
  "CLAUDE_API_KEY",
] as const;

export function resolveAnthropicApiKey(): string | undefined {
  for (const name of AI_KEY_ENV_NAMES) {
    const value = readEnv(name);
    if (value) return value;
  }

  // Last resort: any env key that looks like AI-KEY / AI_KEY ignoring case.
  for (const [key, raw] of Object.entries(process.env)) {
    if (!/^(ai[-_]?key|anthropic_api_key|claude_api_key)$/i.test(key)) continue;
    const value = readEnv(key);
    if (value) return value;
  }

  return undefined;
}

function bool(name: string, fallback = false): boolean {
  const value = readEnv(name)?.toLowerCase();
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value);
}

export function getConfig() {
  return {
    databaseUrl: required("DATABASE_URL"),
    resendApiKey: optional("RESEND_API_KEY"),
    fromEmail: optional("FROM_EMAIL") ?? "The Ebb & Flow <onboarding@resend.dev>",
    /**
     * Tip / reply inbox. When set, Resend sets Reply-To so “just hit reply”
     * reaches the newsroom instead of (or in addition to) FROM_EMAIL.
     */
    replyToEmail: optional("REPLY_TO_EMAIL") ?? optional("REPLY_TO"),
    appUrl: (optional("APP_URL") ?? "http://localhost:3000").replace(/\/$/, ""),
    /** Soft cap for context file uploads (bytes). Default 25 MiB. */
    contextUploadMaxBytes: process.env.CONTEXT_UPLOAD_MAX_BYTES
      ? Number.parseInt(process.env.CONTEXT_UPLOAD_MAX_BYTES, 10)
      : 25 * 1024 * 1024,
    /** Soft cap for extracted upload text (chars). Default 1.5M. */
    contextUploadMaxChars: process.env.CONTEXT_UPLOAD_MAX_CHARS
      ? Number.parseInt(process.env.CONTEXT_UPLOAD_MAX_CHARS, 10)
      : 1_500_000,
    adminPassword: optional("ADMIN_PASSWORD"),
    anthropicApiKey: resolveAnthropicApiKey(),
    /** Always Claude Fable 5 — not overridable. */
    anthropicModel: "claude-fable-5" as const,
    /** When true, saving a story with source_notes triggers Claude rewrite of that issue. */
    anthropicAutoWrite: bool("ANTHROPIC_AUTO_WRITE", false),
    /**
     * Enable auto-draft from transcripts (admin / cron / optional boot).
     * Default true for cron+admin; boot drafting is gated separately.
     */
    autoDraftFromFindings: bool("AUTO_DRAFT_FROM_FINDINGS", true),
    /**
     * When true, also auto-draft on web process boot.
     * Default false — prefer weekly cron or admin to control Claude spend.
     */
    autoDraftOnBoot: bool("AUTO_DRAFT_ON_BOOT", false),
    /** Max topics per auto-draft / propose batch (env name kept for Railway compat). */
    findingsBatchSize: process.env.FINDINGS_BATCH_SIZE
      ? Number.parseInt(process.env.FINDINGS_BATCH_SIZE, 10)
      : 6,
    /** Ketchikan / Tongass Narrows defaults for weather + tides autofill. */
    marineLatitude: Number.parseFloat(optional("MARINE_LATITUDE") ?? "55.3422"),
    marineLongitude: Number.parseFloat(optional("MARINE_LONGITUDE") ?? "-131.6461"),
    marineTimezone: optional("MARINE_TIMEZONE") ?? "America/Juneau",
    /** NOAA CO-OPS station — Ketchikan, AK */
    tideStationId: optional("TIDE_STATION_ID") ?? "9450460",
    issueId: optional("ISSUE_ID"),
    dryRun: bool("DRY_RUN", false),
    maxRecipients: process.env.MAX_RECIPIENTS
      ? Number.parseInt(process.env.MAX_RECIPIENTS, 10)
      : undefined,
    port: Number.parseInt(process.env.PORT ?? "3000", 10),
    /**
     * When true, the web process schedules a weekly send (Mondays 15:00 UTC).
     * If you run a dedicated Railway Cron service (railway.cron.toml), set this
     * false on the web service so only one runner fires.
     */
    weeklyCronEnabled: bool("WEEKLY_CRON_ENABLED", true),
    /** Required in production for /cron/* routes. */
    cronSecret: optional("CRON_SECRET"),
    /** Resend webhook signing secret (whsec_...) for bounce/complaint handling. */
    resendWebhookSecret: optional("RESEND_WEBHOOK_SECRET"),
    /** Require cron secret whenever NODE_ENV=production (default true). */
    requireCronSecretInProduction: bool(
      "REQUIRE_CRON_SECRET_IN_PRODUCTION",
      true
    ),
  };
}

export type AppConfig = ReturnType<typeof getConfig>;
