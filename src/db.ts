import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { Issue, Story, Subscriber } from "./types.js";

const { Pool } = pg;

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");

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

export async function getIssueForSend(
  databaseUrl: string,
  issueId?: string
): Promise<Issue | null> {
  const db = getPool(databaseUrl);

  if (issueId) {
    const { rows } = await db.query<Issue>(
      `SELECT id, issue_date::text, volume_label, subject, preheader, intro,
              weather, high_tides, low_tides, high_tide_label, coming_up,
              cta_url, cta_label, tip_headline, tip_body, postal_address, status
       FROM issues WHERE id = $1`,
      [issueId]
    );
    return rows[0] ?? null;
  }

  const { rows } = await db.query<Issue>(
    `SELECT id, issue_date::text, volume_label, subject, preheader, intro,
            weather, high_tides, low_tides, high_tide_label, coming_up,
            cta_url, cta_label, tip_headline, tip_body, postal_address, status
     FROM issues
     WHERE status = 'ready'
     ORDER BY issue_date DESC, created_at DESC
     LIMIT 1`
  );
  return rows[0] ?? null;
}

export async function getStories(
  databaseUrl: string,
  issueId: string
): Promise<Story[]> {
  const { rows } = await getPool(databaseUrl).query<Story>(
    `SELECT id, issue_id, position, toc_title, title, eyebrow, summary,
            why_it_matters, url, image_url, quote, quote_attribution
     FROM stories
     WHERE issue_id = $1
     ORDER BY position ASC`,
    [issueId]
  );
  return rows;
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
