import { expect, mock, test } from "bun:test";
import type { ProcessorEnv } from "../alchemy.run.ts";
import { MEDIA_RETENTION_MS } from "../src/server/project-retention.ts";

mock.module("cloudflare:workers", () => ({ WorkflowEntrypoint: class {} }));
mock.module("@cloudflare/containers", () => ({ Container: class {}, getContainer: () => { throw new Error("No container"); } }));
const { reconcileFailedIngests, sweepExpiredProjects } = await import("../src/workers/processor.ts");

test("scheduled retention scans only terminal projects past expiry in bounded batches", async () => {
  const now = 1_900_000_000_000;
  let sql = "", cutoff = 0, ledgerCutoff = 0;
  const env = { DB: { prepare: (statement: string) => {
    return { bind: (value: number) => {
      if (statement.startsWith("DELETE FROM upload_admission")) {
        ledgerCutoff = value;
        return { run: async () => ({ meta: { changes: 0 } }) };
      }
      sql = statement;
      cutoff = value;
      return { all: async () => ({ results: [] }) };
    } };
  } } } as unknown as ProcessorEnv;
  expect(await sweepExpiredProjects(env, now)).toBe(0);
  expect(sql).toContain("status IN ('uploading','ready','failed','deleting')");
  expect(sql).toContain("LIMIT 2");
  expect(cutoff).toBe(now - MEDIA_RETENTION_MS - 24 * 60 * 60 * 1000);
  expect(ledgerCutoff).toBe(now - 7 * 24 * 60 * 60 * 1000);
});

test("reconciles only terminal failed Workflows and refunds before marking the project failed", async () => {
  const now = 1_900_000_000_000;
  const actions: string[] = [];
  let state = "running";
  const env = {
    INGEST: { get: async (id: string) => ({ status: async () => {
      expect(id).toBe("ingest-project-1"); return { status: state };
    } }) },
    DB: { prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({
      all: async () => {
        expect(values[0]).toBe(now - 24 * 60 * 60 * 1000);
        return { results: [{ id: "project-1", user_id: "alice" }] };
      },
      run: async () => { actions.push(sql.startsWith("UPDATE project") ? "failed" : "refunded");
        return { meta: { changes: 1 } }; },
    }) }) },
  } as unknown as ProcessorEnv;
  expect(await reconcileFailedIngests(env, now)).toBe(0);
  expect(actions).toEqual([]);
  state = "errored";
  expect(await reconcileFailedIngests(env, now)).toBe(1);
  expect(actions).toEqual(["refunded", "failed"]);
});
