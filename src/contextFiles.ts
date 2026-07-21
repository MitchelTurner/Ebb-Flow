import { getPool } from "./db.js";
import type { Story } from "./types.js";

export interface ContextFile {
  id: string;
  issue_id: string;
  story_position: number | null;
  filename: string;
  mime_type: string;
  byte_size: number;
  content_text: string;
  created_at: string;
}

const SELECT = `
  id, issue_id,
  story_position,
  filename, mime_type, byte_size,
  content_text,
  created_at::text AS created_at`;

export async function listContextFiles(
  databaseUrl: string,
  issueId: string
): Promise<ContextFile[]> {
  const { rows } = await getPool(databaseUrl).query<ContextFile>(
    `SELECT ${SELECT}
     FROM context_files
     WHERE issue_id = $1
     ORDER BY created_at DESC`,
    [issueId]
  );
  return rows;
}

export async function createContextFile(
  databaseUrl: string,
  input: {
    issueId: string;
    storyPosition: number | null;
    filename: string;
    mimeType: string;
    byteSize: number;
    contentText: string;
  }
): Promise<ContextFile> {
  const { rows } = await getPool(databaseUrl).query<ContextFile>(
    `INSERT INTO context_files (
       issue_id, story_position, filename, mime_type, byte_size, content_text
     ) VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${SELECT}`,
    [
      input.issueId,
      input.storyPosition,
      input.filename,
      input.mimeType,
      input.byteSize,
      input.contentText,
    ]
  );
  return rows[0];
}

export async function deleteContextFile(
  databaseUrl: string,
  issueId: string,
  fileId: string
): Promise<boolean> {
  const { rowCount } = await getPool(databaseUrl).query(
    `DELETE FROM context_files WHERE id = $1 AND issue_id = $2`,
    [fileId, issueId]
  );
  return (rowCount ?? 0) > 0;
}

function formatFileBlock(file: ContextFile): string {
  const scope =
    file.story_position == null
      ? "ISSUE-WIDE"
      : `STORY ${file.story_position}`;
  return `UPLOADED CONTEXT (${scope}) — ${file.filename}\n${file.content_text}`;
}

/** Merge uploaded context into story source_notes for Claude / name gate. */
export function storiesWithContextFiles(
  stories: Story[],
  files: ContextFile[]
): Story[] {
  if (!files.length) return stories;

  const issueWide = files.filter((f) => f.story_position == null);
  const byPosition = new Map<number, ContextFile[]>();
  for (const file of files) {
    if (file.story_position == null) continue;
    const list = byPosition.get(file.story_position) ?? [];
    list.push(file);
    byPosition.set(file.story_position, list);
  }

  return stories.map((story) => {
    const attached = [
      ...issueWide,
      ...(byPosition.get(story.position) ?? []),
    ];
    if (!attached.length) return story;
    const block = attached.map(formatFileBlock).join("\n\n---\n\n");
    const base = story.source_notes?.trim() ?? "";
    const merged = base
      ? `${base}\n\n---\n\n${block}`
      : block;
    return { ...story, source_notes: merged };
  });
}

export async function loadStoriesWithContext(
  databaseUrl: string,
  issueId: string,
  stories: Story[]
): Promise<Story[]> {
  const files = await listContextFiles(databaseUrl, issueId);
  return storiesWithContextFiles(stories, files);
}
