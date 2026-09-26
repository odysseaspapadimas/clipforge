import type { D1Database } from "@cloudflare/workers-types";

/** Hard staging safety cap. Independent from customer entitlements; never refund uncertain inference. */
export const STAGING_TOTAL_INFERENCE_MINUTES = 10;

export async function claimStagingInferenceMinutes(db: D1Database, projectId: string, minutes: number): Promise<boolean> {
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > STAGING_TOTAL_INFERENCE_MINUTES) return false;
  const existing = await db.prepare("SELECT minutes FROM inference_spend WHERE project_id = ?")
    .bind(projectId).first<{ minutes: number }>();
  if (existing) return existing.minutes === minutes;
  const insert = await db.prepare(`INSERT OR IGNORE INTO inference_spend (project_id,minutes,created_at)
    SELECT ?,?,? WHERE (SELECT COALESCE(SUM(minutes),0) FROM inference_spend) + ? <= ?`)
    .bind(projectId, minutes, Date.now(), minutes, STAGING_TOTAL_INFERENCE_MINUTES).run();
  if (insert.meta.changes === 1) return true;
  const raced = await db.prepare("SELECT minutes FROM inference_spend WHERE project_id = ?")
    .bind(projectId).first<{ minutes: number }>();
  return raced?.minutes === minutes;
}
