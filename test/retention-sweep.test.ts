import { expect, mock, test } from "bun:test";
import type { ProcessorEnv } from "../alchemy.run.ts";
import { MEDIA_RETENTION_MS } from "../src/server/project-retention.ts";

mock.module("cloudflare:workers", () => ({ WorkflowEntrypoint: class {} }));
mock.module("@cloudflare/containers", () => ({ Container: class {}, getContainer: () => { throw new Error("No container"); } }));
const { sweepExpiredProjects } = await import("../src/workers/processor.ts");

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
