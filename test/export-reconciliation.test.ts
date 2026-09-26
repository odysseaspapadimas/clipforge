import { expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { ProcessorEnv } from "../alchemy.run.ts";

mock.module("cloudflare:workers", () => ({ WorkflowEntrypoint: class {} }));
mock.module("@cloudflare/containers", () => ({ Container: class {}, getContainer: () => { throw Error("No container"); } }));
const { default: processor, reconcileExportTerminal, reconcileFailedExports, sweepExpiredProjects } =
  await import("../src/workers/processor.ts");
const now = 1_900_000_000_000;
const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333"];
function fixture() {
  const sql = new Database(":memory:");
  sql.exec(`CREATE TABLE project(id TEXT PRIMARY KEY,user_id TEXT,status TEXT,source_key TEXT,upload_id TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE clip(id TEXT PRIMARY KEY,project_id TEXT,user_id TEXT,revision INTEGER);
    CREATE TABLE render_job(id TEXT PRIMARY KEY,clip_id TEXT,user_id TEXT,revision INTEGER,status TEXT,error TEXT,queued_at INTEGER,updated_at INTEGER);
    CREATE TABLE upload_admission(created_at INTEGER);`);
  const db = { prepare: (query: string) => ({ bind: (...params: unknown[]) => ({
    run: async () => ({ meta: { changes: sql.prepare(query).run(...params as any[]).changes } }),
    first: async () => sql.prepare(query).get(...params as any[]) ?? null,
    all: async () => ({ results: sql.prepare(query).all(...params as any[]) }),
  }) }), batch: async (statements: Array<{ run: () => Promise<unknown> }>) => {
    for (const statement of statements) await statement.run();
  } } as unknown as ProcessorEnv["DB"];
  const states = new Map<string, string>();
  let checks = 0, restarts = 0, unavailable = false;
  const workflow = { get: async (id: string) => {
    if (unavailable) throw Error("provider unavailable");
    return { id, status: async () => { checks++; return { status: states.get(id) ?? "unknown" }; },
      restart: async () => { restarts++; states.set(id, "running"); } };
  }, create: async () => { throw Error("existing ID"); } };
  const media = { list: async () => ({ objects: [], truncated: false }), delete: async () => {} };
  const env = { DB: db, EXPORT: workflow, MEDIA: media, INTERNAL_SECRET: "local" } as unknown as ProcessorEnv;
  const add = (index: number, status: "ready" | "running" = "running") => {
    const id = ids[index];
    sql.prepare("INSERT INTO project VALUES (?,?,?,?,?,?,?)")
      .run(id, `user-${index}`, "ready", `users/user-${index}/sources/${id}/original`, null, 0, index);
    sql.prepare("INSERT INTO clip VALUES (?,?,?,1)").run(`clip-${id}`, id, `user-${index}`);
    sql.prepare("INSERT INTO render_job VALUES (?,?,?,?,?,NULL,NULL,?)")
      .run(id, `clip-${id}`, `user-${index}`, 1, status, index);
    return id;
  };
  return { sql, env, states, add, get checks() { return checks; }, get restarts() { return restarts; },
    setUnavailable: (state: boolean) => { unavailable = state; },
    post: (id: string) => processor.fetch(new Request("https://internal/internal/export", { method: "POST",
      headers: { "x-clipforge-internal": "local" }, body: JSON.stringify({ jobId: id }) }), env) };
}

test("terminal claimed export is fenced failed; caller can retry same Workflow and then delete source", async () => {
  const f = fixture(), id = f.add(0); f.states.set(`export-${id}`, "errored");
  expect((await f.post(id)).status).toBe(409);
  expect(f.checks).toBe(1);
  expect(f.sql.prepare("SELECT status FROM render_job WHERE id=?").get(id)).toEqual({ status: "failed" });
  expect((await f.post(id)).status).toBe(202);
  expect(f.restarts).toBe(1);
  expect(f.sql.prepare("SELECT status FROM render_job WHERE id=?").get(id)).toEqual({ status: "queued" });
  expect(await sweepExpiredProjects(f.env, now)).toBe(1);
  expect(f.sql.prepare("SELECT id FROM project WHERE id=?").get(id)).toBeNull();
  f.sql.close();
});

test("healthy, waiting, unknown and unavailable Workflow status never unlocks a running export", async () => {
  const f = fixture(), id = f.add(0);
  for (const state of ["running", "waiting", "paused", "unknown"]) {
    f.states.set(`export-${id}`, state);
    expect(await reconcileFailedExports(f.env, now + 6 * 60_000)).toBe(0);
    expect(f.sql.prepare("SELECT status FROM render_job WHERE id=?").get(id)).toEqual({ status: "running" });
    f.sql.prepare("UPDATE render_job SET updated_at=0 WHERE id=?").run(id);
  }
  f.setUnavailable(true);
  expect(await reconcileFailedExports(f.env, now + 6 * 60_000)).toBe(0);
  expect((await f.post(id)).status).toBe(503);
  expect(await sweepExpiredProjects(f.env, now)).toBe(0);
  f.sql.close();
});

test("conditional reconciliation cannot clobber a concurrent successful publication", async () => {
  const f = fixture(), id = f.add(0);
  f.states.set(`export-${id}`, "errored");
  f.env.EXPORT.get = async () => ({ id: `export-${id}`, status: async () => {
    f.sql.prepare("UPDATE render_job SET status='ready' WHERE id=?").run(id);
    return { status: "errored" };
  } }) as any;
  expect(await reconcileExportTerminal(f.env, id, now)).toBe("active");
  expect(f.sql.prepare("SELECT status FROM render_job WHERE id=?").get(id)).toEqual({ status: "ready" });
  f.sql.close();
});

test("rotating two busy oldest accounts permits third expired source removal; terminal one frees next hour", async () => {
  const f = fixture(), first = f.add(0), second = f.add(1), third = f.add(2, "ready");
  f.states.set(`export-${first}`, "terminated"); f.states.set(`export-${second}`, "running");
  expect(await sweepExpiredProjects(f.env, now)).toBe(1);
  expect(f.sql.prepare("SELECT id FROM project WHERE id=?").get(third)).toBeNull();
  expect(await reconcileFailedExports(f.env, now + 6 * 60_000)).toBe(1);
  expect(f.sql.prepare("SELECT status FROM render_job WHERE id=?").get(first)).toEqual({ status: "failed" });
  expect(f.sql.prepare("SELECT status FROM render_job WHERE id=?").get(second)).toEqual({ status: "running" });
  expect(await sweepExpiredProjects(f.env, now + 7 * 60_000)).toBe(1);
  expect(f.sql.prepare("SELECT id FROM project WHERE id=?").get(first)).toBeNull();
  expect(f.sql.prepare("SELECT id FROM project WHERE id=?").get(second)).not.toBeNull();
  f.sql.close();
});
