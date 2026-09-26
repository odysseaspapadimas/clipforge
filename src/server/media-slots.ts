import type { D1Database } from "@cloudflare/workers-types";
import type { WorkflowStep } from "cloudflare:workers";

/** Fixed Container IDs (media-slot-0, media-slot-1) cannot exceed maxInstances: 2. */
export const MEDIA_SLOT_COUNT = 2;
const LEASE_MS = 31 * 60_000; // Longer than any permitted (30m) Workflow step.
export type MediaSlotLease = { slot: number; generation: number; holder: string };
const claimOptions = { retries: { limit: 2, delay: "5 seconds", backoff: "exponential" }, timeout: "1 minute" } as const;

export async function claimMediaSlot(db: D1Database, holder: string, now = Date.now()): Promise<MediaSlotLease | null> {
  if (!/^(prepare|render)-[0-9a-f-]{36}$/.test(holder)) throw new Error("Invalid media slot holder");
  // A successful D1 claim might lose its response; returning the existing lease is idempotent.
  const existing = await db.prepare("SELECT slot,generation,lease_until FROM media_slot WHERE holder = ? AND lease_until > ?")
    .bind(holder, now).first<{ slot: number; generation: number; lease_until: number }>();
  if (existing) return { slot: existing.slot, generation: existing.generation, holder };
  // The subquery and UPDATE are one serialized D1 statement, so concurrent jobs cannot claim the same row.
  let changed = 0;
  try {
    const result = await db.prepare(`UPDATE media_slot SET holder = ?, generation = generation + 1, lease_until = ?
      WHERE slot = (SELECT slot FROM media_slot WHERE lease_until <= ?
        ORDER BY CASE WHEN holder = ? THEN 0 ELSE 1 END, slot LIMIT 1)`)
      .bind(holder, now + LEASE_MS, now, holder).run();
    changed = result.meta.changes;
  } catch (error) {
    // A concurrent retry may have claimed this holder first (enforced by UNIQUE(holder)).
    const won = await db.prepare("SELECT slot,generation FROM media_slot WHERE holder = ? AND lease_until > ?")
      .bind(holder, now).first<{ slot: number; generation: number }>();
    if (won) return { ...won, holder };
    throw error;
  }
  const row = await db.prepare("SELECT slot,generation FROM media_slot WHERE holder = ? AND lease_until > ?")
    .bind(holder, now).first<{ slot: number; generation: number }>();
  if (row) return { ...row, holder };
  if (changed !== 1) return null;
  throw new Error("Media slot claim lost");
}

export async function assertMediaSlot(db: D1Database, lease: MediaSlotLease, now = Date.now()) {
  const row = await db.prepare(`SELECT 1 AS owned FROM media_slot
    WHERE slot = ? AND holder = ? AND generation = ? AND lease_until > ?`)
    .bind(lease.slot, lease.holder, lease.generation, now).first();
  if (!row) throw new Error("Media slot lease expired or was reassigned");
}
export async function releaseMediaSlot(db: D1Database, lease: MediaSlotLease): Promise<void> {
  await db.prepare(`UPDATE media_slot SET holder = NULL,lease_until = 0
    WHERE slot = ? AND holder = ? AND generation = ?`)
    .bind(lease.slot, lease.holder, lease.generation).run();
}

/** Durable, bounded wait: Workflow sleeps do not hold a Worker or Container open. */
export async function waitForMediaSlot(step: WorkflowStep, db: D1Database, holder: string, label: string) {
  for (let attempt = 0; attempt < 90; attempt++) {
    const lease = await step.do(`claim-${label}-${attempt}`, claimOptions, () => claimMediaSlot(db, holder));
    if (lease) return lease;
    await step.sleep(`wait-${label}-${attempt}`, "20 seconds");
  }
  throw new Error("Media capacity wait exceeded 30 minutes");
}
