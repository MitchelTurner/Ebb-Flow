import { getPool } from "./db.js";

export type DraftSourceKind = "transcript" | "external_transcript";

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

type TranscriptShape = {
  idCol: string;
  contentCol: string;
  titleCol: string | null;
  sourceCol: string | null;
  speakerCol: string | null;
  timeCol: string | null;
  usedCol: string | null;
  createdCol: string | null;
};

const CONTENT_CANDIDATES = [
  "transcript",
  "transcript_text",
  "content",
  "full_text",
  "raw_text",
  "text",
  "body",
  "notes",
];

const TITLE_CANDIDATES = ["title", "name", "subject", "headline", "meeting_name"];
const SOURCE_CANDIDATES = ["source", "source_label", "origin", "meeting", "source_url", "url"];
const SPEAKER_CANDIDATES = ["speaker", "author", "participant", "speakers"];
const TIME_CANDIDATES = [
  "recorded_at",
  "created_at",
  "updated_at",
  "timestamp",
  "inserted_at",
  "occurred_at",
  "started_at",
];
const ID_CANDIDATES = ["id", "uuid", "transcript_id", "pk"];
const USED_CANDIDATES = ["used_in_issue_id", "issue_id"];

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

async function getTableColumns(databaseUrl: string, table: string): Promise<string[]> {
  const { rows } = await getPool(databaseUrl).query<{ column_name: string }>(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1`,
    [table]
  );
  return rows.map((r) => r.column_name);
}

function resolveTranscriptShape(columns: string[]): TranscriptShape | null {
  const idCol = pickColumn(columns, ID_CANDIDATES);
  const contentCol = pickColumn(columns, CONTENT_CANDIDATES);
  if (!idCol || !contentCol) return null;
  return {
    idCol,
    contentCol,
    titleCol: pickColumn(columns, TITLE_CANDIDATES),
    sourceCol: pickColumn(columns, SOURCE_CANDIDATES),
    speakerCol: pickColumn(columns, SPEAKER_CANDIDATES),
    timeCol: pickColumn(columns, TIME_CANDIDATES),
    usedCol: pickColumn(columns, USED_CANDIDATES),
    createdCol: pickColumn(columns, ["created_at", "inserted_at"]),
  };
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

function unusedWhere(shape: TranscriptShape, tableParamIndex: number): string {
  const parts = [
    `COALESCE(TRIM(${shape.contentCol}::text), '') <> ''`,
    `NOT EXISTS (
       SELECT 1 FROM source_usage su
       WHERE su.source_table = $${tableParamIndex} AND su.source_id = ${shape.idCol}::text
     )`,
  ];
  if (shape.usedCol) {
    parts.push(`${shape.usedCol} IS NULL`);
  }
  return parts.join("\n         AND ");
}

function orderBy(shape: TranscriptShape): string {
  if (shape.timeCol && shape.createdCol && shape.timeCol !== shape.createdCol) {
    return `${shape.timeCol} DESC NULLS LAST, ${shape.createdCol} DESC NULLS LAST`;
  }
  if (shape.timeCol) return `${shape.timeCol} DESC NULLS LAST`;
  if (shape.createdCol) return `${shape.createdCol} DESC NULLS LAST`;
  return `${shape.idCol} DESC`;
}

async function loadUnusedFromTranscriptTable(
  databaseUrl: string,
  table: string,
  limit: number,
  kind: DraftSourceKind
): Promise<DraftSource[]> {
  if (!isSafeIdent(table)) return [];
  if (!(await tableExists(databaseUrl, table))) return [];

  const columns = await getTableColumns(databaseUrl, table);
  const shape = resolveTranscriptShape(columns);
  if (!shape) {
    console.warn(
      `Skipping table "${table}": need an id column and a text/content/transcript column.`
    );
    return [];
  }

  const selectParts = [
    `${shape.idCol}::text AS id`,
    `${shape.contentCol}::text AS content`,
    shape.titleCol ? `${shape.titleCol}::text AS title` : `''::text AS title`,
    shape.sourceCol ? `${shape.sourceCol}::text AS source` : `''::text AS source`,
    shape.speakerCol ? `${shape.speakerCol}::text AS speaker` : `''::text AS speaker`,
    shape.timeCol ? `${shape.timeCol}::text AS occurred_at` : `NULL::text AS occurred_at`,
  ];

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
       WHERE ${unusedWhere(shape, 1)}
       ORDER BY ${orderBy(shape)}
       LIMIT $2`,
      [table, limit]
    );

    return rows
      .filter((row) => row.content?.trim())
      .map((row) => ({
        kind,
        id: row.id,
        sourceTable: table,
        title: row.title || "",
        content: row.content,
        meta: [row.speaker && `Speaker: ${row.speaker}`, row.source && `Source: ${row.source}`]
          .filter(Boolean)
          .join(" · "),
        occurredAt: row.occurred_at,
        url: row.source?.startsWith("http") ? row.source : "",
        category: row.source || "Transcript",
      }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`Skipping transcript table "${table}": ${message}`);
    return [];
  }
}

/** Newest unused rows from the app/public transcripts table. */
export async function getNewestUnusedTranscripts(
  databaseUrl: string,
  limit: number
): Promise<DraftSource[]> {
  return loadUnusedFromTranscriptTable(databaseUrl, "transcripts", limit, "transcript");
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
       AND table_name NOT IN ('transcripts', 'source_usage', 'stories', 'issues', 'subscribers', 'sends', 'topic_proposals')
       AND (
         table_name ILIKE '%transcript%'
         OR table_name ILIKE '%recording%'
         OR table_name ILIKE '%meeting_note%'
       )
     ORDER BY table_name`
  );

  const out: DraftSource[] = [];
  for (const { table_name: table } of tables) {
    if (out.length >= limit) break;
    const rows = await loadUnusedFromTranscriptTable(
      databaseUrl,
      table,
      limit - out.length,
      "external_transcript"
    );
    out.push(...rows);
  }
  return out;
}

/** Prefer app transcripts, then discovered transcript tables. */
export async function getNewestDraftSources(
  databaseUrl: string,
  limit: number
): Promise<DraftSource[]> {
  const transcripts = await getNewestUnusedTranscripts(databaseUrl, limit);
  if (transcripts.length > 0) return transcripts.slice(0, limit);

  return (await discoverExternalTranscripts(databaseUrl, limit)).slice(0, limit);
}

/** Load specific source rows by id, including already-used ones (for accept/reground). */
export async function getDraftSourcesByRefs(
  databaseUrl: string,
  refs: Array<{ id: string; sourceTable: string; kind?: string }>
): Promise<DraftSource[]> {
  const out: DraftSource[] = [];
  for (const ref of refs) {
    if (!isSafeIdent(ref.sourceTable)) continue;
    if (ref.sourceTable === "findings" || ref.kind === "finding") continue;
    if (!(await tableExists(databaseUrl, ref.sourceTable))) continue;

    const columns = await getTableColumns(databaseUrl, ref.sourceTable);
    const shape = resolveTranscriptShape(columns);
    if (!shape) continue;
    const selectParts = [
      `${shape.idCol}::text AS id`,
      `${shape.contentCol}::text AS content`,
      shape.titleCol ? `${shape.titleCol}::text AS title` : `''::text AS title`,
      shape.sourceCol ? `${shape.sourceCol}::text AS source` : `''::text AS source`,
      shape.speakerCol ? `${shape.speakerCol}::text AS speaker` : `''::text AS speaker`,
      shape.timeCol ? `${shape.timeCol}::text AS occurred_at` : `NULL::text AS occurred_at`,
    ];
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
         FROM ${ref.sourceTable}
         WHERE ${shape.idCol}::text = $1
         LIMIT 1`,
        [ref.id]
      );
      const row = rows[0];
      if (!row?.content?.trim()) continue;
      out.push({
        kind:
          ref.sourceTable === "transcripts" ? "transcript" : "external_transcript",
        id: row.id,
        sourceTable: ref.sourceTable,
        title: row.title || "",
        content: row.content,
        meta: [row.speaker && `Speaker: ${row.speaker}`, row.source && `Source: ${row.source}`]
          .filter(Boolean)
          .join(" · "),
        occurredAt: row.occurred_at,
        url: row.source?.startsWith("http") ? row.source : "",
        category: row.source || "Transcript",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`getDraftSourcesByRefs skipped ${ref.sourceTable}:${ref.id}: ${message}`);
    }
  }
  return out;
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

    if (isSafeIdent(table) && (await tableExists(databaseUrl, table))) {
      const columns = await getTableColumns(databaseUrl, table);
      const idCol = pickColumn(columns, ID_CANDIDATES);
      const usedCol = pickColumn(columns, ["used_in_issue_id"]);
      if (idCol && usedCol) {
        try {
          await getPool(databaseUrl).query(
            `UPDATE ${table}
             SET ${usedCol} = $2::uuid
             WHERE ${idCol}::text = ANY($1::text[])`,
            [ids, issueId]
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.warn(`Could not mark ${table}.${usedCol}: ${message}`);
        }
      }
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
  if (!(await tableExists(databaseUrl, "transcripts"))) {
    throw new Error("transcripts table does not exist");
  }

  const columns = await getTableColumns(databaseUrl, "transcripts");
  const shape = resolveTranscriptShape(columns);
  if (!shape) {
    throw new Error(
      "transcripts table needs an id column and a text/content/transcript column"
    );
  }

  const insertCols: string[] = [shape.contentCol];
  const values: unknown[] = [input.content.trim()];
  const placeholders: string[] = ["$1"];

  if (shape.titleCol) {
    insertCols.push(shape.titleCol);
    values.push(input.title?.trim() || "");
    placeholders.push(`$${values.length}`);
  }
  if (shape.sourceCol) {
    insertCols.push(shape.sourceCol);
    values.push(input.source?.trim() || "");
    placeholders.push(`$${values.length}`);
  }
  if (shape.speakerCol) {
    insertCols.push(shape.speakerCol);
    values.push(input.speaker?.trim() || "");
    placeholders.push(`$${values.length}`);
  }
  if (shape.timeCol) {
    insertCols.push(shape.timeCol);
    values.push(input.recorded_at || null);
    placeholders.push(`COALESCE($${values.length}::timestamptz, now())`);
  }

  const returning = [
    `${shape.idCol}::text AS id`,
    `${shape.contentCol}::text AS content`,
    shape.titleCol ? `${shape.titleCol}::text AS title` : `''::text AS title`,
    shape.sourceCol ? `${shape.sourceCol}::text AS source` : `''::text AS source`,
    shape.speakerCol ? `${shape.speakerCol}::text AS speaker` : `''::text AS speaker`,
    shape.timeCol ? `${shape.timeCol}::text AS recorded_at` : `NULL::text AS recorded_at`,
  ];

  const { rows } = await getPool(databaseUrl).query<{
    id: string;
    title: string;
    content: string;
    source: string;
    speaker: string;
    recorded_at: string | null;
  }>(
    `INSERT INTO transcripts (${insertCols.join(", ")})
     VALUES (${placeholders.join(", ")})
     RETURNING ${returning.join(", ")}`,
    values
  );

  const row = rows[0];
  return {
    kind: "transcript",
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
  const columns = await getTableColumns(databaseUrl, "transcripts");
  const shape = resolveTranscriptShape(columns);
  if (!shape) return [];

  const unusedOnly = opts?.unusedOnly ?? false;
  const where = unusedOnly ? `WHERE ${unusedWhere(shape, 1)}` : "";
  const params = unusedOnly ? ["transcripts"] : [];

  const selectParts = [
    `${shape.idCol}::text AS id`,
    `${shape.contentCol}::text AS content`,
    shape.titleCol ? `${shape.titleCol}::text AS title` : `''::text AS title`,
    shape.sourceCol ? `${shape.sourceCol}::text AS source` : `''::text AS source`,
    shape.speakerCol ? `${shape.speakerCol}::text AS speaker` : `''::text AS speaker`,
    shape.timeCol ? `${shape.timeCol}::text AS recorded_at` : `NULL::text AS recorded_at`,
    shape.usedCol
      ? `${shape.usedCol}::text AS used_in_issue_id`
      : `NULL::text AS used_in_issue_id`,
  ];

  try {
    const { rows } = await getPool(databaseUrl).query(
      `SELECT ${selectParts.join(", ")}
       FROM transcripts
       ${where}
       ORDER BY ${orderBy(shape)}
       LIMIT 200`,
      params
    );
    return rows;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`listTranscripts failed: ${message}`);
    return [];
  }
}

export async function deleteTranscript(
  databaseUrl: string,
  id: string
): Promise<boolean> {
  if (!(await tableExists(databaseUrl, "transcripts"))) return false;
  const columns = await getTableColumns(databaseUrl, "transcripts");
  const shape = resolveTranscriptShape(columns);
  if (!shape) return false;

  const unusedClause = shape.usedCol
    ? `AND ${shape.usedCol} IS NULL`
    : `AND NOT EXISTS (
         SELECT 1 FROM source_usage su
         WHERE su.source_table = 'transcripts' AND su.source_id = ${shape.idCol}::text
       )`;

  const { rowCount } = await getPool(databaseUrl).query(
    `DELETE FROM transcripts
     WHERE ${shape.idCol}::text = $1
       ${unusedClause}`,
    [id]
  );
  return (rowCount ?? 0) > 0;
}

export async function countUnusedTranscriptSources(
  databaseUrl: string
): Promise<number> {
  const owned = await getNewestUnusedTranscripts(databaseUrl, 1000);
  if (owned.length) return owned.length;
  return (await discoverExternalTranscripts(databaseUrl, 1000)).length;
}
