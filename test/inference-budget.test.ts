import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { D1Database } from "@cloudflare/workers-types";
import { claimStagingInferenceMinutes, STAGING_TOTAL_INFERENCE_MINUTES } from "../src/server/inference-budget.ts";

function dbFixture() {
  const sqlite = new Database(":memory:");
  sqlite.exec("CREATE TABLE inference_spend (project_id TEXT PRIMARY KEY, minutes INTEGER NOT NULL, created_at INTEGER NOT NULL)");
  const statement = (sql: string, values: unknown[] = []): any => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async () => sqlite.prepare(sql).get(...values as any[]) ?? null,
    run: async () => ({ meta: { changes: sqlite.prepare(sql).run(...values as any[]).changes } }),
  });
  return { sqlite, db: { prepare: (sql: string) => statement(sql) } as unknown as D1Database };
}
describe("shared staging model-spend guard", () => {
  test("never consumes over ten paid source minutes, including concurrent attempts", async () => {
    const { db, sqlite } = dbFixture();
    expect(STAGING_TOTAL_INFERENCE_MINUTES).toBe(10);
    const claims = await Promise.all([claimStagingInferenceMinutes(db, "first", 6), claimStagingInferenceMinutes(db, "second", 6)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await claimStagingInferenceMinutes(db, "third", 4)).toBe(true);
    expect(await claimStagingInferenceMinutes(db, "fourth", 1)).toBe(false);
    expect(sqlite.prepare("SELECT SUM(minutes) AS spent FROM inference_spend").get()).toEqual({ spent: 10 });
    sqlite.close();
  });
  test("replay of the same project never charges twice and mismatched minutes fail", async () => {
    const { db, sqlite } = dbFixture();
    expect(await claimStagingInferenceMinutes(db, "job", 2)).toBe(true);
    expect(await claimStagingInferenceMinutes(db, "job", 2)).toBe(true);
    expect(await claimStagingInferenceMinutes(db, "job", 3)).toBe(false);
    expect(await claimStagingInferenceMinutes(db, "huge", 120)).toBe(false);
    expect(sqlite.prepare("SELECT SUM(minutes) AS spent FROM inference_spend").get()).toEqual({ spent: 2 });
    sqlite.close();
  });
});
