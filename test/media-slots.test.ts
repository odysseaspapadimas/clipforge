import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { D1Database } from "@cloudflare/workers-types";
import type { WorkflowStep } from "cloudflare:workers";
import { assertMediaSlot, claimMediaSlot, releaseMediaSlot, waitForMediaSlot } from "../src/server/media-slots.ts";

const holders = ["prepare-31ad2058-3721-4864-8e78-6120a4f6e8f9", "render-470886ac-6030-4eb5-8c0e-950e486ab403",
  "prepare-53f3101e-e5b0-43aa-a8c1-0562d06eb746"];
function fixture() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`CREATE TABLE media_slot (slot INTEGER PRIMARY KEY, holder TEXT UNIQUE, generation INTEGER NOT NULL DEFAULT 0,
    lease_until INTEGER NOT NULL DEFAULT 0); INSERT INTO media_slot (slot) VALUES (0),(1);`);
  const statement = (sql: string, values: unknown[] = []): any => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async () => sqlite.prepare(sql).get(...values as any[]) ?? null,
    run: async () => ({ meta: { changes: sqlite.prepare(sql).run(...values as any[]).changes } }),
  });
  return { sqlite, db: { prepare: (sql: string) => statement(sql) } as unknown as D1Database };
}

describe("globally bounded Container admission", () => {
  test("two concurrent claims occupy fixed slots; a third waits, then can take a released slot", async () => {
    const { db, sqlite } = fixture();
    const [first, second] = await Promise.all([claimMediaSlot(db, holders[0]), claimMediaSlot(db, holders[1])]);
    expect([first?.slot, second?.slot].sort()).toEqual([0, 1]);
    expect(await claimMediaSlot(db, holders[2])).toBeNull();
    await assertMediaSlot(db, first!);
    await releaseMediaSlot(db, first!);
    const third = await claimMediaSlot(db, holders[2]);
    expect(third?.slot).toBe(first!.slot);
    expect(third?.generation).toBeGreaterThan(first!.generation);
    await releaseMediaSlot(db, first!); // stale finally block must not release the new owner.
    await assertMediaSlot(db, third!);
    await expect(assertMediaSlot(db, first!)).rejects.toThrow("expired or was reassigned");
    sqlite.close();
  });
  test("a lost response is safe and an expired lease is fenced", async () => {
    const { db, sqlite } = fixture();
    const first = await claimMediaSlot(db, holders[0], 1_000);
    expect(await claimMediaSlot(db, holders[0], 1_001)).toEqual(first);
    const afterExpiry = await claimMediaSlot(db, holders[0], 1_000 + 31 * 60_000 + 1);
    expect(afterExpiry?.slot).toBe(first?.slot);
    expect(afterExpiry?.generation).toBeGreaterThan(first!.generation);
    await expect(assertMediaSlot(db, first!, Date.now())).rejects.toThrow();
    sqlite.close();
  });
  test("Workflow waits durably rather than starting a third Container", async () => {
    const { db, sqlite } = fixture();
    const first = await claimMediaSlot(db, holders[0]);
    await claimMediaSlot(db, holders[1]);
    let sleeps = 0;
    const step = { do: async (_name: string, _options: unknown, fn: () => Promise<unknown>) => fn(),
      sleep: async () => { sleeps++; await releaseMediaSlot(db, first!); },
    } as unknown as WorkflowStep;
    const lease = await waitForMediaSlot(step, db, holders[2], "test");
    expect(sleeps).toBe(1);
    expect(lease.slot).toBe(first!.slot);
    sqlite.close();
  });
});
