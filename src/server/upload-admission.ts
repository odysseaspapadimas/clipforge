import type { D1Database } from "@cloudflare/workers-types";

/** A single SQLite/D1 write fences concurrent multipart admissions across Worker instances. */
export async function admitUpload(db: D1Database, input: {
  id: string; userId: string; title: string; sourceKey: string; uploadId: string;
  fileSize: number; mimeType: string; now: number;
}): Promise<boolean> {
  const { id, userId, title, sourceKey, uploadId, fileSize, mimeType, now } = input;
  // A D1 batch executes in one transaction: count, project admission and the
  // persistent event cannot interleave with another account upload.
  const results = await db.batch([
    db.prepare(`INSERT INTO project
      (id,user_id,title,source_key,upload_id,file_size,mime_type,status,created_at,updated_at)
      SELECT ?,?,?,?,?,?,?,'uploading',?,?
      WHERE (SELECT COUNT(*) FROM project WHERE user_id = ? AND status IN ('uploading','queued','processing')) < 2
        AND (SELECT COUNT(*) FROM upload_admission WHERE user_id = ? AND created_at >= ?) < 10
        AND EXISTS (SELECT 1 FROM subscription WHERE user_id = ? AND status = 'active' AND period_end > ?)`)
      .bind(id, userId, title, sourceKey, uploadId, fileSize, mimeType, now, now,
        userId, userId, now - 24 * 60 * 60 * 1000, userId, now),
    db.prepare(`INSERT INTO upload_admission (id,user_id,created_at)
      SELECT id,user_id,created_at FROM project WHERE id = ? AND user_id = ?`)
      .bind(id, userId),
  ]);
  return results[0].meta.changes === 1;
}
