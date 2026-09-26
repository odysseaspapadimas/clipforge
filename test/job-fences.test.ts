import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { D1Database } from "@cloudflare/workers-types";
import { claimExportStart, claimIngestStart } from "../src/server/job-fences.ts";

function fixture() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`CREATE TABLE project (id TEXT PRIMARY KEY,user_id TEXT,status TEXT,updated_at INTEGER);
    CREATE TABLE clip (id TEXT PRIMARY KEY,project_id TEXT,user_id TEXT,revision INTEGER);
    CREATE TABLE render_job (id TEXT PRIMARY KEY,clip_id TEXT,user_id TEXT,revision INTEGER,status TEXT,updated_at INTEGER);
    INSERT INTO project VALUES ('queued','alice','queued',0),('ready','alice','ready',0);
    INSERT INTO clip VALUES ('clip','ready','alice',1);
    INSERT INTO render_job VALUES ('job','clip','alice',1,'queued',0);`);
  const db = { prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({ run: async () => ({
    meta: { changes: sqlite.prepare(sql).run(...values as any[]).changes },
  }) }) }) } as unknown as D1Database;
  return { sqlite, db };
}

test("a queued ingest is either claimed for processing or safely cancellable, never both", async () => {
  const { sqlite, db } = fixture();
  sqlite.prepare("UPDATE project SET status='deleting' WHERE id='queued' AND status='queued'").run();
  expect(await claimIngestStart(db, "queued")).toBe(false);
  sqlite.prepare("UPDATE project SET status='queued' WHERE id='queued'").run();
  expect(await claimIngestStart(db, "queued")).toBe(true);
  expect(sqlite.prepare("UPDATE project SET status='deleting' WHERE id='queued' AND status='queued'").run().changes).toBe(0);
  sqlite.close();
});

test("a queued export is fenced by current project, clip revision and the claim-before-render transition", async () => {
  const { sqlite, db } = fixture();
  sqlite.prepare("UPDATE project SET status='deleting' WHERE id='ready'").run();
  expect(await claimExportStart(db, "job")).toBe(false);
  sqlite.prepare("UPDATE project SET status='ready' WHERE id='ready'").run();
  sqlite.prepare("UPDATE clip SET revision=2 WHERE id='clip'").run();
  expect(await claimExportStart(db, "job")).toBe(false);
  sqlite.prepare("UPDATE clip SET revision=1 WHERE id='clip'").run();
  expect(await claimExportStart(db, "job")).toBe(true);
  expect(sqlite.prepare("SELECT status FROM render_job WHERE id='job'").get()).toEqual({ status: "running" });
  expect(await claimExportStart(db, "job")).toBe(false);
  sqlite.close();
});
