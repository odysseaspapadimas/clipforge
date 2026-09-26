import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { D1Database } from "@cloudflare/workers-types";
import { admitUpload } from "../src/server/upload-admission.ts";

function fixture() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`CREATE TABLE subscription (user_id TEXT PRIMARY KEY,status TEXT,period_end INTEGER);
    CREATE TABLE project (id TEXT PRIMARY KEY,user_id TEXT,title TEXT,source_key TEXT UNIQUE,upload_id TEXT,
      file_size INTEGER,mime_type TEXT,status TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE upload_admission (id TEXT PRIMARY KEY,user_id TEXT,created_at INTEGER);
    INSERT INTO subscription (user_id,status,period_end) VALUES ('alice','active',9999999999999);`);
  const prepare = (sql: string, values: unknown[] = []): any => ({
    bind: (...params: unknown[]) => prepare(sql, params),
    runSync: () => ({ meta: { changes: sqlite.prepare(sql).run(...values as any[]).changes } }),
  });
  const db = { prepare: (sql: string) => prepare(sql),
    batch: async (statements: Array<{ runSync: () => unknown }>) => sqlite.transaction(() =>
      statements.map((statement) => statement.runSync()))(),
  } as unknown as D1Database;
  const now = Date.now();
  const admit = (id: string) => admitUpload(db, { id, userId: "alice", title: "Interview", sourceKey: `users/alice/${id}`,
    uploadId: `multipart-${id}`, fileSize: 100, mimeType: "video/mp4", now });
  return { sqlite, admit, now };
}

test("atomic upload admission prevents the third simultaneous active job and rejects after cancellation", async () => {
  const { sqlite, admit } = fixture();
  const result = await Promise.all([admit("a"), admit("b"), admit("c")]);
  expect(result.filter(Boolean).length).toBe(2);
  expect(sqlite.prepare("SELECT COUNT(*) AS count FROM project").get()).toEqual({ count: 2 });
  sqlite.prepare("UPDATE subscription SET status='canceled' WHERE user_id='alice'").run();
  expect(await admit("d")).toBe(false);
  sqlite.close();
});

test("the same statement also enforces the rolling daily cap after jobs complete", async () => {
  const { sqlite, admit, now } = fixture();
  for (let index = 0; index < 9; index++) {
    sqlite.prepare(`INSERT INTO upload_admission VALUES (?,?,?)`).run(`prior-${index}`, "alice", now);
  }
  expect(await admit("tenth")).toBe(true);
  // Deleting the project does not reset the rolling daily counter.
  sqlite.prepare("DELETE FROM project WHERE id='tenth'").run();
  expect(await admit("eleventh")).toBe(false);
  sqlite.close();
});
