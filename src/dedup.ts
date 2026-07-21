import { getPool } from "./db.js";

export type RecentStoryRef = {
  issue_date: string;
  title: string;
  summary: string;
};

/** Recent published/drafted story titles for cross-week dedup. */
export async function getRecentStoryFingerprints(
  databaseUrl: string,
  weeks = 4
): Promise<RecentStoryRef[]> {
  const { rows } = await getPool(databaseUrl).query<RecentStoryRef>(
    `SELECT i.issue_date::text, s.title, LEFT(s.summary, 280) AS summary
     FROM stories s
     JOIN issues i ON i.id = s.issue_id
     WHERE i.issue_date >= (CURRENT_DATE - ($1::int * 7))
       AND i.status IN ('draft', 'ready', 'sending', 'sent')
     ORDER BY i.issue_date DESC, s.position ASC
     LIMIT 80`,
    [weeks]
  );
  return rows;
}
