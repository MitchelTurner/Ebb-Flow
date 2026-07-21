import { getPool } from "./db.js";

export const ALLOWED_ANALYTICS_EVENTS = [
  "page_view",
  "cta_view",
  "form_start",
  "subscribe_submit",
  "subscribe_success",
  "subscribe_error",
  "archive_click",
  "sample_click",
] as const;

export type AnalyticsEventName = (typeof ALLOWED_ANALYTICS_EVENTS)[number];

export function isAllowedAnalyticsEvent(
  name: string
): name is AnalyticsEventName {
  return (ALLOWED_ANALYTICS_EVENTS as readonly string[]).includes(name);
}

export async function recordAnalyticsEvent(
  databaseUrl: string,
  input: {
    name: AnalyticsEventName;
    path?: string;
    referrer?: string;
    utm_source?: string;
    utm_medium?: string;
    utm_campaign?: string;
    meta?: Record<string, unknown>;
  }
): Promise<void> {
  await getPool(databaseUrl).query(
    `INSERT INTO analytics_events (
       name, path, referrer, utm_source, utm_medium, utm_campaign, meta
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      input.name,
      (input.path || "/").slice(0, 500),
      (input.referrer || "").slice(0, 500),
      (input.utm_source || "").slice(0, 120),
      (input.utm_medium || "").slice(0, 120),
      (input.utm_campaign || "").slice(0, 120),
      JSON.stringify(input.meta ?? {}),
    ]
  );
}

/** Rounded subscriber count for public social proof (never over-precise). */
export function formatNeighborProof(activeCount: number): {
  active_subscribers: number;
  proof_label: string;
} {
  if (activeCount < 12) {
    return {
      active_subscribers: activeCount,
      proof_label: "Join the early readers along the Narrows",
    };
  }
  const rounded = Math.floor(activeCount / 10) * 10;
  return {
    active_subscribers: activeCount,
    proof_label: `Join ${rounded}+ neighbors reading Mondays`,
  };
}

export async function getPublicLandingStats(databaseUrl: string): Promise<{
  active_subscribers: number;
  proof_label: string;
  sent_issues: number;
}> {
  const { rows } = await getPool(databaseUrl).query<{
    active_subscribers: number;
    sent_issues: number;
  }>(`
    SELECT
      (SELECT COUNT(*)::int FROM subscribers WHERE status = 'active') AS active_subscribers,
      (SELECT COUNT(*)::int FROM issues WHERE status = 'sent') AS sent_issues
  `);
  const active = rows[0]?.active_subscribers ?? 0;
  const proof = formatNeighborProof(active);
  return {
    ...proof,
    sent_issues: rows[0]?.sent_issues ?? 0,
  };
}

export async function getAnalyticsFunnel(
  databaseUrl: string,
  days = 7
): Promise<Record<string, number>> {
  const { rows } = await getPool(databaseUrl).query<{
    name: string;
    count: number;
  }>(
    `SELECT name, COUNT(*)::int AS count
     FROM analytics_events
     WHERE created_at > now() - ($1::int * interval '1 day')
     GROUP BY name`,
    [Math.max(1, Math.min(90, days))]
  );
  const out: Record<string, number> = {};
  for (const name of ALLOWED_ANALYTICS_EVENTS) out[name] = 0;
  for (const row of rows) out[row.name] = row.count;
  return out;
}
