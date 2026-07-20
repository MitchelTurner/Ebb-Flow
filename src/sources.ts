import { getPool } from "./db.js";

export type DraftSourceKind = "transcript" | "finding" | "external_transcript";

export interface DraftSource {
  kind: DraftSourceKind;
  /** Stable id within source_table */
  id: string;
  sourceTable: string;
  title: string;
  content: string;
  meta: string;
  occurredAt: string | null;
  url: string;
  category: string;
}

function isSafeIdent(name: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);
}

function pickColumn(columns: string[], candidates: string[]): string | null {
  const lower = new Map(columns.map((c) => [c.toLowerCase(), c]));
  for (const candidate of candidates) {
    const hit = lower.get(candidate.toLowerCase());
    if (hit) return hit;
  }
  return null;
}

async function tableExists(databaseUrl: string, table: string): Promise<boolean> {
  const { rows } = await getPool(databaseUrl).query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1
     ) AS exists`,
    [table]
  );
  return Boolean(rows[0]?.exists);
}

async function markSourceUsage(
  databaseUrl: string,
  sourceTable: string,
  sourceIds: string[],
  issueId: string
): Promise<void> {
  if (!sourceIds.length) return;
  const db = getPool(databaseUrl);
  for (const sourceId of sourceIds) {
    await db.query(
      `INSERT INTO source_usage (source_table, source_id, issue_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (source_table, source_id) DO UPDATE SET
         issue_id = EXCLUDED.issue_id,
         used_at = now()`,
      [sourceTable, sourceId, issueId]
    );
  }
}

/** Newest unused rows from the app's own transcripts table. */
export async function getNewestUnusedTranscripts(
  databaseUrl: string,
  limit: number
): Promise<DraftSource[]> {
  if (!(await tableExists(databaseUrl, "transcripts"))) return [];

  const { rows } = await getPool(databaseUrl).query<{
    id: string;
    title: string;
    content: string;
    source: string;
    speaker: string;
    recorded_at: string;
  }>(
    `SELECT id::text, title, content, source, speaker, recorded_at::text
     FROM transcripts
     WHERE used_in_issue_id IS NULL
     ORDER BY recorded_at DESC, created_at DESC
     LIMIT $1`,
    [limit]
  );

  return rows
    .filter((row) => row.content?.trim())
    .map((row) => ({
      kind: "transcript" as const,
      id: row.id,
      sourceTable: "transcripts",
      title: row.title || "",
      content: row.content,
      meta: [row.speaker && `Speaker: ${row.speaker}`, row.source && `Source: ${row.source}`]
        .filter(Boolean)
        .join(" · "),
      occurredAt: row.recorded_at,
      url: "",
      category: row.source || "Transcript",
    }));
}

/** Newest unused findings (legacy / tip stream). */
export async function getNewestUnusedFindingsAsSources(
  databaseUrl: string,
  limit: number
): Promise<DraftSource[]> {
  if (!(await tableExists(databaseUrl, "findings"))) return [];

  const { rows } = await getPool(databaseUrl).query<{
    id: string;
    title: string;
    body: string;
    source_url: string;
    category: string;
    found_at: string;
  }>(
    `SELECT id::text, title, body, source_url, category, found_at::text
     FROM findings
     WHERE used_in_issue_id IS NULL
     ORDER BY found_at DESC, created_at DESC
     LIMIT $1`,
    [limit]
  );

  return rows
    .filter((row) => row.body?.trim())
    .map((row) => ({
      kind: "finding" as const,
      id: row.id,
      sourceTable: "findings",
      title: row.title || "",
      content: row.body,
      meta: row.category || "",
      occurredAt: row.found_at,
      url: row.source_url || "",
      category: row.category || "Local",
    }));
}

/**
 * Discover other public tables whose names look like transcripts and load
 * newest rows not yet recorded in source_usage.
 */
export async function discoverExternalTranscripts(
  databaseUrl: string,
  limit: number
): Promise<DraftSource[]> {
  const { rows: tables } = await getPool(databaseUrl).query<{ table_name: string }>(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_type = 'BASE TABLE'
       AND table_name NOT IN ('transcripts', 'findings', 'source_usage', 'stories', 'issues', 'subscribers', 'sends', 'tasks')
       AND (
         table_name ILIKE '%transcript%'
         OR table_name ILIKE '%recording%'
         OR table_name ILIKE '%meeting_note%'
       )
     ORDER BY table_name`
  );

  const out: DraftSource[] = [];

  for (const { table_name: table } of tables) {
    if (!isSafeIdent(table)) continue;
    if (out.length >= limit) break;

    const { rows: cols } = await getPool(databaseUrl).query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1`,
      [table]
    );
    const columns = cols.map((c) => c.column_name);
    const idCol = pickColumn(columns, ["id", "uuid", "transcript_id", "pk"]);
    const contentCol = pickColumn(columns, [
      "transcript",
      "transcript_text",
      "content",
      "full_text",
      "raw_text",
      "text",
      "body",
      "notes",
    ]);
    if (!idCol || !contentCol) continue;

    const titleCol = pickColumn(columns, ["title", "name", "subject", "headline"]);
    const sourceCol = pickColumn(columns, ["source", "source_url", "url", "origin"]);
    const speakerCol = pickColumn(columns, ["speaker", "author", "participant"]);
    const timeCol = pickColumn(columns, [
      "recorded_at",
      "created_at",
      "updated_at",
      "timestamp",
      "inserted_at",
      "occurred_at",
    ]);

    const selectParts = [
      `${idCol}::text AS id`,
      `${contentCol}::text AS content`,
      titleCol ? `${titleCol}::text AS title` : `''::text AS title`,
      sourceCol ? `${sourceCol}::text AS source` : `''::text AS source`,
      speakerCol ? `${speakerCol}::text AS speaker` : `''::text AS speaker`,
      timeCol ? `${timeCol}::text AS occurred_at` : `NULL::text AS occurred_at`,
    ];

    const orderBy = timeCol ? `${timeCol} DESC NULLS LAST` : `${idCol} DESC`;
    const remaining = limit - out.length;

    try {
      const { rows } = await getPool(databaseUrl).query<{
        id: string;
        content: string;
        title: string;
        source: string;
        speaker: string;
        occurred_at: string | null;
      }>(
        `SELECT ${selectParts.join(", ")}
         FROM ${table}
         WHERE COALESCE(TRIM(${contentCol}::text), '') <> ''
           AND NOT EXISTS (
             SELECT 1 FROM source_usage su
             WHERE su.source_table = $1 AND su.source_id = ${idCol}::text
           )
         ORDER BY ${orderBy}
         LIMIT $2`,
        [table, remaining]
      );

      for (const row of rows) {
        out.push({
          kind: "external_transcript",
          id: row.id,
          sourceTable: table,
          title: row.title || "",
          content: row.content,
          meta: [row.speaker && `Speaker: ${row.speaker}`, row.source && `Source: ${row.source}`]
            .filter(Boolean)
            .join(" · "),
          occurredAt: row.occurred_at,
          url: row.source?.startsWith("http") ? row.source : "",
          category: "Transcript",
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`Skipping transcript table "${table}": ${message}`);
    }
  }

  return out;
}

/** Prefer app transcripts, then discovered transcript tables, then findings. */
export async function getNewestDraftSources(
  databaseUrl: string,
  limit: number
): Promise<DraftSource[]> {
  const transcripts = await getNewestUnusedTranscripts(databaseUrl, limit);
  if (transcripts.length > 0) return transcripts.slice(0, limit);

  const external = await discoverExternalTranscripts(databaseUrl, limit);
  if (external.length > 0) return external.slice(0, limit);

  return (await getNewestUnusedFindingsAsSources(databaseUrl, limit)).slice(0, limit);
}

export async function markDraftSourcesUsed(
  databaseUrl: string,
  sources: DraftSource[],
  issueId: string
): Promise<void> {
  const byTable = new Map<string, DraftSource[]>();
  for (const source of sources) {
    const list = byTable.get(source.sourceTable) ?? [];
    list.push(source);
    byTable.set(source.sourceTable, list);
  }

  for (const [table, rows] of byTable) {
    const ids = rows.map((r) => r.id);

    if (table === "transcripts" && (await tableExists(databaseUrl, "transcripts"))) {
      await getPool(databaseUrl).query(
        `UPDATE transcripts
         SET used_in_issue_id = $2
         WHERE id = ANY($1::uuid[])`,
        [ids, issueId]
      );
    }

    if (table === "findings" && (await tableExists(databaseUrl, "findings"))) {
      await getPool(databaseUrl).query(
        `UPDATE findings
         SET used_in_issue_id = $2
         WHERE id = ANY($1::uuid[])`,
        [ids, issueId]
      );
    }

    // Always record in source_usage for idempotency / external tables.
    await markSourceUsage(databaseUrl, table, ids, issueId);
  }
}

const MAX_TRANSCRIPT_CHARS = 40_000;

export function sourceToNotes(source: DraftSource): string {
  let content = source.content.trim();
  if (content.length > MAX_TRANSCRIPT_CHARS) {
    content =
      content.slice(0, MAX_TRANSCRIPT_CHARS) +
      "\n…[transcript truncated for drafting]";
  }
  return [
    source.title.trim() ? `Title: ${source.title.trim()}` : "",
    source.category.trim() ? `Category: ${source.category.trim()}` : "",
    source.meta.trim() ? source.meta.trim() : "",
    source.occurredAt ? `When: ${source.occurredAt}` : "",
    source.url.trim() ? `URL: ${source.url.trim()}` : "",
    "TRANSCRIPT / SOURCE TEXT:",
    content,
  ]
    .filter(Boolean)
    .join("\n");
}

export async function createTranscript(
  databaseUrl: string,
  input: {
    title?: string;
    content: string;
    source?: string;
    speaker?: string;
    recorded_at?: string;
  }
): Promise<DraftSource> {
  const { rows } = await getPool(databaseUrl).query<{
    id: string;
    title: string;
    content: string;
    source: string;
    speaker: string;
    recorded_at: string;
  }>(
    `INSERT INTO transcripts (title, content, source, speaker, recorded_at)
     VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, now()))
     RETURNING id::text, title, content, source, speaker, recorded_at::text`,
    [
      input.title?.trim() || "",
      input.content.trim(),
      input.source?.trim() || "",
      input.speaker?.trim() || "",
      input.recorded_at || null,
    ]
  );
  const row = rows[0];
  return {
    kind: "transcript",
    id: row.id,
    sourceTable: "transcripts",
    title: row.title,
    content: row.content,
    meta: [row.speaker && `Speaker: ${row.speaker}`, row.source && `Source: ${row.source}`]
      .filter(Boolean)
      .join(" · "),
    occurredAt: row.recorded_at,
    url: "",
    category: row.source || "Transcript",
  };
}

export async function listTranscripts(
  databaseUrl: string,
  opts?: { unusedOnly?: boolean }
): Promise<
  Array<{
    id: string;
    title: string;
    content: string;
    source: string;
    speaker: string;
    recorded_at: string;
    used_in_issue_id: string | null;
  }>
> {
  if (!(await tableExists(databaseUrl, "transcripts"))) return [];
  const unusedOnly = opts?.unusedOnly ?? false;
  const { rows } = await getPool(databaseUrl).query(
    `SELECT id::text, title, content, source, speaker, recorded_at::text, used_in_issue_id::text
     FROM transcripts
     ${unusedOnly ? "WHERE used_in_issue_id IS NULL" : ""}
     ORDER BY recorded_at DESC, created_at DESC`
  );
  return rows;
}

export async function deleteTranscript(
  databaseUrl: string,
  id: string
): Promise<boolean> {
  if (!(await tableExists(databaseUrl, "transcripts"))) return false;
  const { rowCount } = await getPool(databaseUrl).query(
    `DELETE FROM transcripts WHERE id = $1 AND used_in_issue_id IS NULL`,
    [id]
  );
  return (rowCount ?? 0) > 0;
}

export async function countUnusedTranscriptSources(
  databaseUrl: string
): Promise<number> {
  const owned = await getNewestUnusedTranscripts(databaseUrl, 1000);
  if (owned.length) return owned.length;
  const external = await discoverExternalTranscripts(databaseUrl, 1000);
  if (external.length) return external.length;
  const findings = await getNewestUnusedFindingsAsSources(databaseUrl, 1000);
  return findings.length;
}
