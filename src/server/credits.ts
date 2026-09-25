import type { D1Database } from "@cloudflare/workers-types";

/** Exactly one request is allowed to create a Stripe customer. A stuck claim requires operator reconciliation. */
export async function claimCustomerCreation(db: D1Database, userId: string): Promise<boolean> {
  const result = await db.prepare(`INSERT OR IGNORE INTO subscription
    (user_id,customer_id,status,checkout_created_at,last_event_created) VALUES (?,?,'customer_pending',?,0)`)
    .bind(userId, `cus_pending_${userId}`, Date.now()).run();
  return result.meta.changes === 1;
}

/** Ledger keys are unique and every credit belongs to a single, expiring invoice period. */
export async function balance(db: D1Database, userId: string): Promise<number> {
  const row = await db.prepare(`SELECT COALESCE(SUM(l.delta), 0) AS amount FROM minute_ledger l
    JOIN subscription s ON s.user_id = l.user_id AND s.current_invoice = l.period_key
    WHERE l.user_id = ? AND s.status = 'active' AND s.period_end > ?`)
    .bind(userId, Date.now()).first<{ amount: number }>();
  return row?.amount ?? 0;
}
export async function reserveMinutes(db: D1Database, userId: string, projectId: string, minutes: number): Promise<boolean> {
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 120) throw new Error("Invalid source minutes");
  const prior = await db.prepare("SELECT user_id, delta, period_key FROM minute_ledger WHERE key = ?")
    .bind(`reserve:${projectId}`).first<{ user_id: string; delta: number; period_key: string }>();
  if (prior) {
    if (prior.user_id !== userId || prior.delta !== -minutes) return false;
    const released = await db.prepare("SELECT 1 FROM minute_ledger WHERE key = ?").bind(`release:${projectId}`).first();
    return !released;
  }
  const result = await db.prepare(`INSERT INTO minute_ledger (key, user_id, period_key, delta, kind, project_id, created_at)
    SELECT ?, s.user_id, s.current_invoice, -?, 'reserve', ?, ? FROM subscription s
    WHERE s.user_id = ? AND s.status = 'active' AND s.period_end > ? AND s.current_invoice IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM minute_ledger WHERE key = ?)
    AND (SELECT COALESCE(SUM(delta), 0) FROM minute_ledger WHERE user_id = s.user_id AND period_key = s.current_invoice) >= ?`)
    .bind(`reserve:${projectId}`, minutes, projectId, Date.now(), userId, Date.now(), `reserve:${projectId}`, minutes).run();
  return result.meta.changes === 1;
}
export async function releaseMinutes(db: D1Database, userId: string, projectId: string): Promise<void> {
  await db.prepare(`INSERT INTO minute_ledger (key, user_id, period_key, delta, kind, project_id, created_at)
    SELECT ?, user_id, period_key, -delta, 'release', project_id, ? FROM minute_ledger
    WHERE key = ? AND user_id = ? AND NOT EXISTS (SELECT 1 FROM minute_ledger WHERE key = ?)`)
    .bind(`release:${projectId}`, Date.now(), `reserve:${projectId}`, userId, `release:${projectId}`).run();
}
export async function grantPeriod(db: D1Database, input: {
  userId: string; subscriptionId: string; invoiceId: string; minutes: number;
  periodStart: number; periodEnd: number;
}): Promise<void> {
  const { userId, subscriptionId, invoiceId, minutes, periodStart, periodEnd } = input;
  if (!/^in_[a-zA-Z0-9]+$/.test(invoiceId) || !subscriptionId.startsWith("sub_") ||
    !Number.isSafeInteger(minutes) || minutes < 1 || minutes > 100_000 ||
    !Number.isSafeInteger(periodStart) || !Number.isSafeInteger(periodEnd) || periodEnd <= periodStart) {
    throw new Error("Invalid invoice grant");
  }
  // D1 batch is atomic. A late older invoice cannot replace the current period.
  await db.batch([
    db.prepare(`UPDATE subscription SET status = 'active', subscription_id = ?, current_invoice = ?,
      period_start = ?, period_end = ? WHERE user_id = ? AND (subscription_id IS NULL OR subscription_id = ?
      OR (status IN ('past_due','checkout_pending','none') AND COALESCE(period_end,0) < ?))
      AND status NOT IN ('canceled','unpaid','paused')
      AND (period_start IS NULL OR period_start <= ?)
      AND NOT EXISTS (SELECT 1 FROM minute_ledger WHERE key = ?)`)
      .bind(subscriptionId, invoiceId, periodStart, periodEnd, userId, subscriptionId, Date.now(), periodStart, `grant:${invoiceId}`),
    db.prepare(`INSERT OR IGNORE INTO minute_ledger (key,user_id,period_key,delta,kind,created_at)
      SELECT ?, user_id, ?, ?, 'grant', ? FROM subscription
      WHERE user_id = ? AND subscription_id = ? AND current_invoice = ? AND status = 'active'`)
      .bind(`grant:${invoiceId}`, invoiceId, minutes, Date.now(), userId, subscriptionId, invoiceId),
  ]);
}
