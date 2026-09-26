import { expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { ProcessorEnv } from "../alchemy.run.ts";

mock.module("cloudflare:workers", () => ({ WorkflowEntrypoint: class {} }));
mock.module("@cloudflare/containers", () => ({ Container: class {}, getContainer: () => { throw Error("No container"); } }));
const { recoverQueuedStarts, ensureIngestWorkflow, sweepExpiredProjects } = await import("../src/workers/processor.ts");
function fixture(now: number) {
  const sql = new Database(":memory:");
  sql.exec(`CREATE TABLE project (id TEXT PRIMARY KEY,user_id TEXT,status TEXT,source_key TEXT,upload_id TEXT,
    created_at INTEGER,queued_at INTEGER,updated_at INTEGER,error TEXT);
    CREATE TABLE clip (id TEXT PRIMARY KEY,project_id TEXT,user_id TEXT,revision INTEGER);
    CREATE TABLE render_job (id TEXT PRIMARY KEY,clip_id TEXT,user_id TEXT,revision INTEGER,status TEXT,
      error TEXT,queued_at INTEGER,updated_at INTEGER);
    CREATE TABLE upload_admission (created_at INTEGER);`);
  const DB = { prepare: (statement: string) => ({ bind: (...params: unknown[]) => ({
    run: async () => ({ meta: { changes: sql.prepare(statement).run(...params as any[]).changes } }),
    first: async () => sql.prepare(statement).get(...params as any[]) ?? null,
    all: async () => ({ results: sql.prepare(statement).all(...params as any[]) }),
  }) }), batch: async (statements: Array<{ run: () => Promise<unknown> }>) => {
    for (const statement of statements) await statement.run();
  } } as unknown as ProcessorEnv["DB"];
  let failCreates = true, attempts: string[] = [];
  const instance = (id: string) => ({ id, status: async () => ({ status: "running" }), restart: async () => {} });
  const workflow = { create: async ({ id }: { id: string }) => {
    attempts.push(id);
    if (failCreates) throw Error("down");
    return instance(id);
  }, get: async (id: string) => { if (failCreates) throw Error("down"); return instance(id); } };
  const MEDIA = { list: async () => ({ objects: [], truncated: false }), delete: async () => {} };
  return { sql, env: { DB, INGEST: workflow, EXPORT: workflow, MEDIA } as unknown as ProcessorEnv,
    attempts, setOnline: () => { failCreates = false; }, now };
}

test("orphan queued ingest/export recover with same deterministic IDs, without charging minutes", async () => {
  const now = 1_900_000_000_000, f = fixture(now);
  f.sql.prepare("INSERT INTO project VALUES (?,?,?,?,?,?,?,?,?)")
    .run("p", "alice", "queued", "users/alice/sources/p/original", null, now - 10_000_000, now - 600_000, now - 600_000, null);
  f.sql.prepare("INSERT INTO project VALUES (?,?,?,?,?,?,?,?,?)")
    .run("r", "alice", "ready", "users/alice/sources/r/original", null, now - 10_000_000, null, now - 600_000, null);
  f.sql.exec("INSERT INTO clip VALUES ('c','r','alice',1)");
  f.sql.prepare("INSERT INTO render_job VALUES (?,?,?,?,?,?,?,?)").run("j", "c", "alice", 1, "queued", null, now - 600_000, now - 600_000);
  expect(await recoverQueuedStarts(f.env, now)).toEqual({ retried: 0, timedOut: 0 });
  expect(f.attempts).toEqual(["ingest-p", "export-j"]);
  expect(f.sql.prepare("SELECT status FROM project WHERE id='p'").get()).toEqual({ status: "queued" });
  // The queued_at timestamp must survive the retry rotation for the 24-hour cap.
  expect(f.sql.prepare("SELECT queued_at FROM project WHERE id='p'").get()).toEqual({ queued_at: now - 600_000 });
  f.setOnline();
  expect(await ensureIngestWorkflow(f.env, "p")).toBe("ingest-p");
  expect(await recoverQueuedStarts(f.env, now + 6 * 60_000)).toEqual({ retried: 2, timedOut: 0 });
  expect(f.attempts.slice(-2)).toEqual(["ingest-p", "export-j"]);
  f.sql.close();
});

test("timed-out queued jobs free upload slots without retrying Workflow or charging", async () => {
  const now = 1_900_000_000_000, f = fixture(now);
  f.sql.prepare("INSERT INTO project VALUES (?,?,?,?,?,?,?,?,?)")
    .run("old", "alice", "queued", "users/alice/sources/old/original", null, now - 100_000_000, now - 90_000_000, now - 600_000, null);
  expect(await recoverQueuedStarts(f.env, now)).toEqual({ retried: 0, timedOut: 1 });
  expect(f.sql.prepare("SELECT status FROM project WHERE id='old'").get()).toEqual({ status: "failed" });
  expect(f.attempts).toEqual([]);
  f.sql.prepare("INSERT INTO project VALUES (?,?,?,?,?,?,?,?,?)")
    .run("ready", "alice", "ready", "users/alice/sources/ready/original", null, 0, null, 0, null);
  f.sql.exec("INSERT INTO clip VALUES ('clip','ready','alice',1)");
  f.sql.prepare("INSERT INTO render_job VALUES (?,?,?,?,?,?,?,?)")
    .run("stuck-export", "clip", "alice", 1, "queued", null, now - 90_000_000, now - 600_000);
  expect(await recoverQueuedStarts(f.env, now)).toEqual({ retried: 0, timedOut: 1 });
  expect(f.sql.prepare("SELECT status FROM render_job WHERE id='stuck-export'").get()).toEqual({ status: "failed" });
  f.sql.close();
});

test("two busy oldest projects cannot starve a third expired owner's deletion", async () => {
  const now = 1_900_000_000_000, f = fixture(now);
  for (const [index, id] of ["busy-1", "busy-2", "deletable"].entries()) {
    f.sql.prepare("INSERT INTO project VALUES (?,?,?,?,?,?,?,?,?)")
      .run(id, `owner-${index}`, "ready", `users/owner-${index}/sources/${id}/original`, null, 0, null, index, null);
    f.sql.prepare("INSERT INTO clip VALUES (?,?,?,?)").run(`c-${id}`, id, `owner-${index}`, 1);
    if (index < 2) f.sql.prepare("INSERT INTO render_job VALUES (?,?,?,?,?,?,?,?)")
      .run(`j-${id}`, `c-${id}`, `owner-${index}`, 1, "running", null, null, 0);
  }
  expect(await sweepExpiredProjects(f.env, now)).toBe(1);
  expect(f.sql.prepare("SELECT id,updated_at FROM project ORDER BY id").all()).toEqual([
    { id: "busy-1", updated_at: now }, { id: "busy-2", updated_at: now },
  ]);
  f.sql.close();
});
