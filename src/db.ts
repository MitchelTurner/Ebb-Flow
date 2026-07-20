import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type {
  DashboardStats,
  Issue,
  IssueStatus,
  Story,
  Subscriber,
  SubscriberStatus,
  Task,
  TaskStatus,
} from "./types.js";

const { Pool } = pg;

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");

const ISSUE_SELECT = `id, issue_date::text, volume_label, subject, preheader, intro,
  weather, high_tides, low_tides, high_tide_label, coming_up,
  cta_url, cta_label, tip_headline, tip_body, postal_address, status,
  created_at::text, updated_at::text, sent_at::text`;

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

export async function getDashboardStats(databaseUrl: string): Promise<DashboardStats> {
  const { rows } = await getPool(databaseUrl).query<DashboardStats>(`
    SELECT
      (SELECT COUNT(*)::int FROM subscribers WHERE status = 'active') AS active_subscribers,
      (SELECT COUNT(*)::int FROM subscribers) AS total_subscribers,
      (SELECT COUNT(*)::int FROM issues WHERE status = 'draft') AS draft_issues,
      (SELECT COUNT(*)::int FROM issues WHERE status = 'ready') AS ready_issues,
      (SELECT COUNT(*)::int FROM tasks WHERE status IN ('todo', 'doing')) AS open_tasks
  `);
  return rows[0];
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

  const { rows } = await db.query<Issue>(
    `SELECT ${ISSUE_SELECT}
     FROM issues
     WHERE status = 'ready'
     ORDER BY issue_date DESC, created_at DESC
     LIMIT 1`
  );
  return rows[0] ?? null;
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
       cta_url, cta_label, tip_headline, tip_body, postal_address, status
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16
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
      input.cta_label ?? "Read the full stories →",
      input.tip_headline ?? "Got a tip or a story we missed?",
      input.tip_body ?? "Just hit reply — every message reaches the newsroom directly.",
      input.postal_address ?? "",
      input.status ?? "draft",
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
    ]
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
  COALESCE(source_notes, '') AS source_notes`;

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
         source_notes = $13
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
      ]
    );
    if (!rows[0]) throw new Error("Story not found");
    return rows[0];
  }

  const { rows } = await getPool(databaseUrl).query<Story>(
    `INSERT INTO stories (
       issue_id, position, toc_title, title, eyebrow, summary,
       why_it_matters, url, image_url, quote, quote_attribution, source_notes
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
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
       source_notes = EXCLUDED.source_notes
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

export async function listTasks(databaseUrl: string): Promise<Task[]> {
  const { rows } = await getPool(databaseUrl).query<Task>(
    `SELECT id, title, notes, status, due_date::text, issue_id,
            created_at::text, updated_at::text
     FROM tasks
     ORDER BY
       CASE status WHEN 'doing' THEN 0 WHEN 'todo' THEN 1 ELSE 2 END,
       due_date NULLS LAST,
       created_at DESC`
  );
  return rows;
}

export async function createTask(
  databaseUrl: string,
  input: {
    title: string;
    notes?: string;
    status?: TaskStatus;
    due_date?: string | null;
    issue_id?: string | null;
  }
): Promise<Task> {
  const { rows } = await getPool(databaseUrl).query<Task>(
    `INSERT INTO tasks (title, notes, status, due_date, issue_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, title, notes, status, due_date::text, issue_id,
               created_at::text, updated_at::text`,
    [
      input.title.trim(),
      input.notes ?? "",
      input.status ?? "todo",
      input.due_date || null,
      input.issue_id || null,
    ]
  );
  return rows[0];
}

export async function updateTask(
  databaseUrl: string,
  id: string,
  input: Partial<{
    title: string;
    notes: string;
    status: TaskStatus;
    due_date: string | null;
    issue_id: string | null;
  }>
): Promise<Task | null> {
  const { rows: existing } = await getPool(databaseUrl).query<Task>(
    `SELECT id, title, notes, status, due_date::text, issue_id
     FROM tasks WHERE id = $1`,
    [id]
  );
  const current = existing[0];
  if (!current) return null;

  const { rows } = await getPool(databaseUrl).query<Task>(
    `UPDATE tasks SET
       title = $2,
       notes = $3,
       status = $4,
       due_date = $5,
       issue_id = $6,
       updated_at = now()
     WHERE id = $1
     RETURNING id, title, notes, status, due_date::text, issue_id,
               created_at::text, updated_at::text`,
    [
      id,
      input.title ?? current.title,
      input.notes ?? current.notes,
      input.status ?? current.status,
      input.due_date !== undefined ? input.due_date : current.due_date,
      input.issue_id !== undefined ? input.issue_id : current.issue_id,
    ]
  );
  return rows[0] ?? null;
}

export async function deleteTask(databaseUrl: string, id: string): Promise<boolean> {
  const { rowCount } = await getPool(databaseUrl).query(
    `DELETE FROM tasks WHERE id = $1`,
    [id]
  );
  return (rowCount ?? 0) > 0;
}

export type { IssueStatus, SubscriberStatus, TaskStatus };
