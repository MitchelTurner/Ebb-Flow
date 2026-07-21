import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type {
  DashboardStats,
  Issue,
  IssueStatus,
  SendFailureRow,
  SendOpsSnapshot,
  Story,
  Subscriber,
  SubscriberStatus,
} from "./types.js";

const { Pool } = pg;

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");

const ISSUE_SELECT = `id, issue_date::text, volume_label, subject, preheader, intro,
  weather, high_tides, low_tides, high_tide_label, coming_up,
  cta_url, cta_label, tip_headline, tip_body, postal_address, status,
  scheduled_for::text, fact_reviewed_at::text, created_at::text, updated_at::text, sent_at::text`;

let pool: pg.Pool | undefined;

export function getPool(databaseUrl: string): pg.Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: databaseUrl,
      ssl: databaseUrl.includes("localhost")
        ? undefined
        : { rejectUnauthorized: false },
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

export async function runSqlFile(databaseUrl: string, relativePath: string): Promise<void> {
  const sql = readFileSync(join(rootDir, relativePath), "utf8");
  const client = await getPool(databaseUrl).connect();
  try {
    await client.query(sql);
  } finally {
    client.release();
  }
}

async function countUnusedSourceRows(
  databaseUrl: string,
  table: "transcripts"
): Promise<number> {
  const db = getPool(databaseUrl);
  const { rows: colRows } = await db.query<{ column_name: string }>(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1`,
    [table]
  );
  if (!colRows.length) return 0;

  const cols = new Map(colRows.map((r) => [r.column_name.toLowerCase(), r.column_name]));
  const idCol =
    cols.get("id") || cols.get("uuid") || cols.get("transcript_id") || cols.get("pk");
  if (!idCol || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(idCol)) return 0;

  const usedCol = cols.get("used_in_issue_id");
  const usedClause = usedCol ? `AND t.${usedCol} IS NULL` : "";

  try {
    const { rows } = await db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
       FROM ${table} t
       WHERE NOT EXISTS (
         SELECT 1 FROM source_usage su
         WHERE su.source_table = $1 AND su.source_id = t.${idCol}::text
       )
       ${usedClause}`,
      [table]
    );
    return Number(rows[0]?.count ?? 0);
  } catch {
    return 0;
  }
}

export async function getDashboardStats(databaseUrl: string): Promise<DashboardStats> {
  const { rows } = await getPool(databaseUrl).query<Omit<DashboardStats, "unused_transcripts">>(`
    SELECT
      (SELECT COUNT(*)::int FROM subscribers WHERE status = 'active') AS active_subscribers,
      (SELECT COUNT(*)::int FROM subscribers) AS total_subscribers,
      (SELECT COUNT(*)::int FROM subscribers WHERE status = 'bounced') AS bounced_subscribers,
      (SELECT COUNT(*)::int FROM issues WHERE status = 'draft') AS draft_issues,
      (SELECT COUNT(*)::int FROM issues WHERE status = 'ready') AS ready_issues,
      (SELECT COUNT(*)::int FROM issues
        WHERE status = 'ready' AND scheduled_for IS NOT NULL AND scheduled_for > now()) AS scheduled_issues,
      (SELECT COUNT(*)::int FROM sends
        WHERE status = 'failed' AND created_at > now() - interval '7 days') AS failed_sends_7d,
      (SELECT COUNT(*)::int FROM sends
        WHERE status = 'sent' AND COALESCE(sent_at, created_at) > now() - interval '7 days') AS sent_7d
  `);

  const unused_transcripts = await countUnusedSourceRows(databaseUrl, "transcripts");

  return {
    ...rows[0],
    unused_transcripts,
  };
}

/** Send-ops panel: bounce counts, recent failures, due queue. */
export async function getSendOpsSnapshot(
  databaseUrl: string
): Promise<SendOpsSnapshot> {
  const db = getPool(databaseUrl);
  const { rows: counts } = await db.query<{
    bounced_subscribers: number;
    failed_sends_7d: number;
    sent_7d: number;
    ready_due: number;
  }>(`
    SELECT
      (SELECT COUNT(*)::int FROM subscribers WHERE status = 'bounced') AS bounced_subscribers,
      (SELECT COUNT(*)::int FROM sends
        WHERE status = 'failed' AND created_at > now() - interval '7 days') AS failed_sends_7d,
      (SELECT COUNT(*)::int FROM sends
        WHERE status = 'sent' AND COALESCE(sent_at, created_at) > now() - interval '7 days') AS sent_7d,
      (SELECT COUNT(*)::int FROM issues
        WHERE status IN ('ready', 'sending')
          AND (scheduled_for IS NULL OR scheduled_for <= now())) AS ready_due
  `);

  const { rows: recent_failures } = await db.query<SendFailureRow>(
    `SELECT s.issue_id::text AS issue_id,
            i.subject,
            sub.email,
            s.error,
            s.created_at::text AS created_at
     FROM sends s
     JOIN issues i ON i.id = s.issue_id
     JOIN subscribers sub ON sub.id = s.subscriber_id
     WHERE s.status = 'failed'
     ORDER BY s.created_at DESC
     LIMIT 12`
  );

  return {
    bounced_subscribers: counts[0]?.bounced_subscribers ?? 0,
    failed_sends_7d: counts[0]?.failed_sends_7d ?? 0,
    sent_7d: counts[0]?.sent_7d ?? 0,
    ready_due: counts[0]?.ready_due ?? 0,
    recent_failures,
  };
}

export async function subscribe(
  databaseUrl: string,
  email: string,
  firstName?: string | null
): Promise<Subscriber> {
  const { rows } = await getPool(databaseUrl).query<Subscriber>(
    `INSERT INTO subscribers (email, first_name, status)
     VALUES ($1, $2, 'active')
     ON CONFLICT (email) DO UPDATE SET
       first_name = COALESCE(EXCLUDED.first_name, subscribers.first_name),
       status = 'active',
       updated_at = now()
     RETURNING id, email, first_name, status,
               unsubscribe_token::text AS unsubscribe_token,
               created_at::text, updated_at::text`,
    [email.toLowerCase().trim(), firstName?.trim() || null]
  );
  return rows[0];
}

export async function listSubscribers(databaseUrl: string): Promise<Subscriber[]> {
  const { rows } = await getPool(databaseUrl).query<Subscriber>(
    `SELECT id, email, first_name, status,
            unsubscribe_token::text AS unsubscribe_token,
            created_at::text, updated_at::text
     FROM subscribers
     ORDER BY created_at DESC`
  );
  return rows;
}

export async function updateSubscriberStatus(
  databaseUrl: string,
  id: string,
  status: SubscriberStatus
): Promise<Subscriber | null> {
  const { rows } = await getPool(databaseUrl).query<Subscriber>(
    `UPDATE subscribers
     SET status = $2, updated_at = now()
     WHERE id = $1
     RETURNING id, email, first_name, status,
               unsubscribe_token::text AS unsubscribe_token,
               created_at::text, updated_at::text`,
    [id, status]
  );
  return rows[0] ?? null;
}

export async function deleteSubscriber(
  databaseUrl: string,
  id: string
): Promise<boolean> {
  const { rowCount } = await getPool(databaseUrl).query(
    `DELETE FROM subscribers WHERE id = $1`,
    [id]
  );
  return (rowCount ?? 0) > 0;
}

export async function getIssueForSend(
  databaseUrl: string,
  issueId?: string
): Promise<Issue | null> {
  const db = getPool(databaseUrl);

  if (issueId) {
    const { rows } = await db.query<Issue>(
      `SELECT ${ISSUE_SELECT} FROM issues WHERE id = $1`,
      [issueId]
    );
    return rows[0] ?? null;
  }

  // Prefer due scheduled issues, then unscheduled ready issues.
  const { rows } = await db.query<Issue>(
    `SELECT ${ISSUE_SELECT}
     FROM issues
     WHERE status = 'ready'
       AND (scheduled_for IS NULL OR scheduled_for <= now())
     ORDER BY
       CASE WHEN scheduled_for IS NULL THEN 1 ELSE 0 END,
       scheduled_for ASC NULLS LAST,
       issue_date DESC,
       created_at DESC
     LIMIT 1`
  );
  return rows[0] ?? null;
}

export async function listDueIssues(databaseUrl: string): Promise<Issue[]> {
  const { rows } = await getPool(databaseUrl).query<Issue>(
    `SELECT ${ISSUE_SELECT}
     FROM issues
     WHERE status IN ('ready', 'sending')
       AND (scheduled_for IS NULL OR scheduled_for <= now())
     ORDER BY scheduled_for ASC NULLS LAST, created_at ASC`
  );
  return rows;
}

/** Published issues for the public archive. */
export async function listSentIssues(
  databaseUrl: string,
  limit = 52
): Promise<Issue[]> {
  const { rows } = await getPool(databaseUrl).query<Issue>(
    `SELECT ${ISSUE_SELECT}
     FROM issues
     WHERE status = 'sent'
     ORDER BY issue_date DESC, sent_at DESC NULLS LAST
     LIMIT $1`,
    [limit]
  );
  return rows;
}

export async function listSentSubscriberIds(
  databaseUrl: string,
  issueId: string
): Promise<Set<string>> {
  const { rows } = await getPool(databaseUrl).query<{ subscriber_id: string }>(
    `SELECT subscriber_id::text AS subscriber_id
     FROM sends
     WHERE issue_id = $1 AND status = 'sent'`,
    [issueId]
  );
  return new Set(rows.map((row) => row.subscriber_id));
}

export async function listReviewIssues(databaseUrl: string): Promise<Issue[]> {
  const { rows } = await getPool(databaseUrl).query<Issue>(
    `SELECT ${ISSUE_SELECT}
     FROM issues
     WHERE status IN ('draft', 'ready')
     ORDER BY
       CASE status WHEN 'draft' THEN 0 ELSE 1 END,
       scheduled_for ASC NULLS LAST,
       created_at DESC`
  );
  return rows;
}

export async function listIssues(databaseUrl: string): Promise<Issue[]> {
  const { rows } = await getPool(databaseUrl).query<Issue>(
    `SELECT ${ISSUE_SELECT}
     FROM issues
     ORDER BY issue_date DESC, created_at DESC`
  );
  return rows;
}

export async function createIssue(
  databaseUrl: string,
  input: Partial<Issue> & { issue_date: string; subject: string }
): Promise<Issue> {
  const comingUp = input.coming_up ?? [];
  const { rows } = await getPool(databaseUrl).query<Issue>(
    `INSERT INTO issues (
       issue_date, volume_label, subject, preheader, intro,
       weather, high_tides, low_tides, high_tide_label, coming_up,
       cta_url, cta_label, tip_headline, tip_body, postal_address, status, scheduled_for
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17
     )
     RETURNING ${ISSUE_SELECT}`,
    [
      input.issue_date,
      input.volume_label ?? "",
      input.subject,
      input.preheader ?? "",
      input.intro ?? "",
      input.weather ?? "",
      input.high_tides ?? "",
      input.low_tides ?? "",
      input.high_tide_label ?? "",
      comingUp,
      input.cta_url ?? "",
      input.cta_label ?? "",
      input.tip_headline ?? "Got a tip or a story we missed?",
      input.tip_body ?? "Just hit reply — every message reaches the newsroom directly.",
      input.postal_address ?? "",
      input.status ?? "draft",
      input.scheduled_for ?? null,
    ]
  );
  return rows[0];
}

export async function updateIssue(
  databaseUrl: string,
  id: string,
  input: Partial<Issue>
): Promise<Issue | null> {
  const current = await getIssueForSend(databaseUrl, id);
  if (!current) return null;

  const next = {
    ...current,
    ...input,
    coming_up: input.coming_up ?? current.coming_up,
  };

  const { rows } = await getPool(databaseUrl).query<Issue>(
    `UPDATE issues SET
       issue_date = $2,
       volume_label = $3,
       subject = $4,
       preheader = $5,
       intro = $6,
       weather = $7,
       high_tides = $8,
       low_tides = $9,
       high_tide_label = $10,
       coming_up = $11,
       cta_url = $12,
       cta_label = $13,
       tip_headline = $14,
       tip_body = $15,
       postal_address = $16,
       status = $17,
       scheduled_for = $18,
       fact_reviewed_at = $19::timestamptz,
       updated_at = now()
     WHERE id = $1
     RETURNING ${ISSUE_SELECT}`,
    [
      id,
      next.issue_date,
      next.volume_label,
      next.subject,
      next.preheader,
      next.intro,
      next.weather,
      next.high_tides,
      next.low_tides,
      next.high_tide_label,
      next.coming_up,
      next.cta_url,
      next.cta_label,
      next.tip_headline,
      next.tip_body,
      next.postal_address,
      next.status,
      next.scheduled_for ?? null,
      next.fact_reviewed_at ?? null,
    ]
  );
  return rows[0] ?? null;
}

export async function scheduleIssue(
  databaseUrl: string,
  id: string,
  scheduledFor: string
): Promise<Issue | null> {
  const { rows } = await getPool(databaseUrl).query<Issue>(
    `UPDATE issues
     SET status = 'ready',
         scheduled_for = $2::timestamptz,
         updated_at = now()
     WHERE id = $1 AND status IN ('draft', 'ready')
     RETURNING ${ISSUE_SELECT}`,
    [id, scheduledFor]
  );
  return rows[0] ?? null;
}

export async function deleteIssue(databaseUrl: string, id: string): Promise<boolean> {
  const { rowCount } = await getPool(databaseUrl).query(
    `DELETE FROM issues WHERE id = $1`,
    [id]
  );
  return (rowCount ?? 0) > 0;
}

const STORY_SELECT = `id, issue_id, position, toc_title, title, eyebrow, summary,
  why_it_matters, url, image_url, quote, quote_attribution,
  COALESCE(source_notes, '') AS source_notes, finding_id`;

export async function getStories(
  databaseUrl: string,
  issueId: string
): Promise<Story[]> {
  const { rows } = await getPool(databaseUrl).query<Story>(
    `SELECT ${STORY_SELECT}
     FROM stories
     WHERE issue_id = $1
     ORDER BY position ASC`,
    [issueId]
  );
  return rows;
}

export async function upsertStory(
  databaseUrl: string,
  issueId: string,
  input: Omit<Story, "id" | "issue_id"> & { id?: string }
): Promise<Story> {
  const sourceNotes = input.source_notes ?? "";
  const findingId = input.finding_id ?? null;

  if (input.id) {
    const { rows } = await getPool(databaseUrl).query<Story>(
      `UPDATE stories SET
         position = $3,
         toc_title = $4,
         title = $5,
         eyebrow = $6,
         summary = $7,
         why_it_matters = $8,
         url = $9,
         image_url = $10,
         quote = $11,
         quote_attribution = $12,
         source_notes = $13,
         finding_id = $14
       WHERE id = $1 AND issue_id = $2
       RETURNING ${STORY_SELECT}`,
      [
        input.id,
        issueId,
        input.position,
        input.toc_title,
        input.title,
        input.eyebrow,
        input.summary,
        input.why_it_matters,
        input.url,
        input.image_url,
        input.quote,
        input.quote_attribution,
        sourceNotes,
        findingId,
      ]
    );
    if (!rows[0]) throw new Error("Story not found");
    return rows[0];
  }

  const { rows } = await getPool(databaseUrl).query<Story>(
    `INSERT INTO stories (
       issue_id, position, toc_title, title, eyebrow, summary,
       why_it_matters, url, image_url, quote, quote_attribution, source_notes, finding_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (issue_id, position) DO UPDATE SET
       toc_title = EXCLUDED.toc_title,
       title = EXCLUDED.title,
       eyebrow = EXCLUDED.eyebrow,
       summary = EXCLUDED.summary,
       why_it_matters = EXCLUDED.why_it_matters,
       url = EXCLUDED.url,
       image_url = EXCLUDED.image_url,
       quote = EXCLUDED.quote,
       quote_attribution = EXCLUDED.quote_attribution,
       source_notes = EXCLUDED.source_notes,
       finding_id = EXCLUDED.finding_id
     RETURNING ${STORY_SELECT}`,
    [
      issueId,
      input.position,
      input.toc_title,
      input.title,
      input.eyebrow,
      input.summary,
      input.why_it_matters,
      input.url,
      input.image_url,
      input.quote,
      input.quote_attribution,
      sourceNotes,
      findingId,
    ]
  );
  return rows[0];
}

export async function deleteStory(
  databaseUrl: string,
  issueId: string,
  storyId: string
): Promise<boolean> {
  const { rowCount } = await getPool(databaseUrl).query(
    `DELETE FROM stories WHERE id = $1 AND issue_id = $2`,
    [storyId, issueId]
  );
  return (rowCount ?? 0) > 0;
}

export async function getActiveSubscribers(
  databaseUrl: string,
  limit?: number
): Promise<Subscriber[]> {
  const params: unknown[] = [];
  let sql = `
    SELECT id, email, first_name, status, unsubscribe_token::text AS unsubscribe_token
    FROM subscribers
    WHERE status = 'active'
    ORDER BY created_at ASC`;

  if (limit !== undefined && Number.isFinite(limit) && limit > 0) {
    params.push(limit);
    sql += ` LIMIT $1`;
  }

  const { rows } = await getPool(databaseUrl).query<Subscriber>(sql, params);
  return rows;
}

export async function markIssueSending(
  databaseUrl: string,
  issueId: string
): Promise<void> {
  await getPool(databaseUrl).query(
    `UPDATE issues SET status = 'sending', updated_at = now() WHERE id = $1`,
    [issueId]
  );
}

export async function markIssueSent(
  databaseUrl: string,
  issueId: string
): Promise<void> {
  await getPool(databaseUrl).query(
    `UPDATE issues SET status = 'sent', sent_at = now(), updated_at = now() WHERE id = $1`,
    [issueId]
  );
}

/** Re-queue a partial send so cron can retry remaining recipients. */
export async function markIssueReadyForRetry(
  databaseUrl: string,
  issueId: string
): Promise<void> {
  await getPool(databaseUrl).query(
    `UPDATE issues SET status = 'ready', updated_at = now() WHERE id = $1`,
    [issueId]
  );
}

export async function updateSubscriberStatusByEmail(
  databaseUrl: string,
  email: string,
  status: SubscriberStatus
): Promise<Subscriber | null> {
  const { rows } = await getPool(databaseUrl).query<Subscriber>(
    `UPDATE subscribers
     SET status = $2, updated_at = now()
     WHERE lower(email) = lower($1)
     RETURNING id, email, first_name, status,
               unsubscribe_token::text AS unsubscribe_token,
               created_at::text, updated_at::text`,
    [email.trim(), status]
  );
  return rows[0] ?? null;
}

export async function updateSubscriberPreferences(
  databaseUrl: string,
  token: string,
  input: { first_name?: string | null; status?: SubscriberStatus }
): Promise<Subscriber | null> {
  const { rows } = await getPool(databaseUrl).query<Subscriber>(
    `UPDATE subscribers
     SET
       first_name = COALESCE($2, first_name),
       status = COALESCE($3, status),
       updated_at = now()
     WHERE unsubscribe_token = $1
     RETURNING id, email, first_name, status,
               unsubscribe_token::text AS unsubscribe_token,
               created_at::text, updated_at::text`,
    [
      token,
      input.first_name === undefined
        ? null
        : input.first_name?.trim() || null,
      input.status ?? null,
    ]
  );
  return rows[0] ?? null;
}

export async function recordSend(params: {
  databaseUrl: string;
  issueId: string;
  subscriberId: string;
  providerId: string | null;
  status: "sent" | "failed" | "skipped";
  error?: string | null;
}): Promise<void> {
  await getPool(params.databaseUrl).query(
    `INSERT INTO sends (issue_id, subscriber_id, provider_id, status, error, sent_at)
     VALUES ($1, $2, $3, $4, $5, CASE WHEN $4 = 'sent' THEN now() ELSE NULL END)
     ON CONFLICT (issue_id, subscriber_id) DO UPDATE SET
       provider_id = EXCLUDED.provider_id,
       status = EXCLUDED.status,
       error = EXCLUDED.error,
       sent_at = EXCLUDED.sent_at`,
    [
      params.issueId,
      params.subscriberId,
      params.providerId,
      params.status,
      params.error ?? null,
    ]
  );
}

export async function unsubscribeByToken(
  databaseUrl: string,
  token: string
): Promise<Subscriber | null> {
  const { rows } = await getPool(databaseUrl).query<Subscriber>(
    `UPDATE subscribers
     SET status = 'unsubscribed', updated_at = now()
     WHERE unsubscribe_token = $1
     RETURNING id, email, first_name, status, unsubscribe_token::text AS unsubscribe_token`,
    [token]
  );
  return rows[0] ?? null;
}

export async function getSubscriberByToken(
  databaseUrl: string,
  token: string
): Promise<Subscriber | null> {
  const { rows } = await getPool(databaseUrl).query<Subscriber>(
    `SELECT id, email, first_name, status, unsubscribe_token::text AS unsubscribe_token
     FROM subscribers
     WHERE unsubscribe_token = $1`,
    [token]
  );
  return rows[0] ?? null;
}

export type { IssueStatus, SubscriberStatus };
