import type { D1Database } from "@cloudflare/workers-types";

type PurgeMedia = Pick<R2Bucket, "list" | "delete" | "resumeMultipartUpload">;

export const MEDIA_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
/** Conservative cutoff: upload creation precedes the R2 source object's creation. */
export function projectExpired(createdAt: number, now = Date.now()): boolean {
  return createdAt <= now - MEDIA_RETENTION_MS;
}

/** Claim a terminal project first to fence new edits/exports. A failed purge is retryable. */
export async function purgeProject(db: D1Database, media: PurgeMedia, userId: string, projectId: string): Promise<"deleted" | "busy" | "missing"> {
  const claimed = await db.prepare(`UPDATE project SET status = 'deleting', updated_at = ?
    WHERE id = ? AND user_id = ? AND status IN ('uploading','queued','ready','failed')
    AND NOT EXISTS (SELECT 1 FROM render_job j JOIN clip c ON c.id = j.clip_id
      WHERE c.project_id = project.id AND j.status = 'running')`)
    .bind(Date.now(), projectId, userId).run();
  const project = await db.prepare("SELECT source_key AS sourceKey,upload_id AS uploadId,status FROM project WHERE id = ? AND user_id = ?")
    .bind(projectId, userId).first<{ sourceKey: string; uploadId: string | null; status: string }>();
  if (!project) return "missing";
  if (claimed.meta.changes !== 1 && project.status !== "deleting") return "busy";

  // Only derive deletion prefixes from the authenticated owner and project/clip IDs, never request keys.
  if (project.uploadId) await media.resumeMultipartUpload(project.sourceKey, project.uploadId).abort();
  const clips = await db.prepare("SELECT id FROM clip WHERE project_id = ? AND user_id = ?")
    .bind(projectId, userId).all<{ id: string }>();
  const prefixes = [`users/${userId}/sources/${projectId}/`, `users/${userId}/audio/${projectId}/`,
    `users/${userId}/transcripts/${projectId}/`, ...clips.results.map((clip) => `users/${userId}/outputs/${clip.id}/`)];
  for (const prefix of prefixes) {
    let cursor: string | undefined;
    const keys: string[] = [];
    do {
      const result = await media.list({ prefix, cursor, limit: 1000 });
      keys.push(...result.objects.map((object) => object.key));
      cursor = result.truncated ? result.cursor : undefined;
      if (result.truncated && !cursor) throw new Error("R2 listing did not return a cursor");
    } while (cursor);
    for (let start = 0; start < keys.length; start += 1000) await media.delete(keys.slice(start, start + 1000));
  }
  // Keep pseudonymous minute/inference spend ledger rows; remove transcript, clips, jobs and project.
  await db.batch([
    db.prepare(`DELETE FROM render_job WHERE user_id = ? AND clip_id IN
      (SELECT id FROM clip WHERE project_id = ? AND user_id = ?)`).bind(userId, projectId, userId),
    db.prepare("DELETE FROM project WHERE id = ? AND user_id = ? AND status = 'deleting'").bind(projectId, userId),
  ]);
  return "deleted";
}
