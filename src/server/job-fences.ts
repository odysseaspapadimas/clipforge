import type { D1Database } from "@cloudflare/workers-types";

/** The first Workflow operation fences queued-project deletion before any media or credit side effect. */
export async function claimIngestStart(db: D1Database, projectId: string, now = Date.now()): Promise<boolean> {
  const result = await db.prepare("UPDATE project SET status = 'processing',updated_at = ? WHERE id = ? AND status = 'queued'")
    .bind(now, projectId).run();
  return result.meta.changes === 1;
}

/** A queued render may be deleted, but only before its Workflow atomically claims it. */
export async function claimExportStart(db: D1Database, jobId: string, now = Date.now()): Promise<boolean> {
  const result = await db.prepare(`UPDATE render_job SET status = 'running',updated_at = ?
    WHERE id = ? AND status = 'queued' AND EXISTS
    (SELECT 1 FROM clip c JOIN project p ON p.id = c.project_id AND p.user_id = render_job.user_id
      WHERE c.id = render_job.clip_id AND c.user_id = render_job.user_id
        AND c.revision = render_job.revision AND p.status = 'ready')`)
    .bind(now, jobId).run();
  return result.meta.changes === 1;
}
