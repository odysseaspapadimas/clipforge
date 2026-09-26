import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { projectExpired, purgeProject } from "../src/server/project-retention.ts";

test("tenant-scoped purge retries after R2 failure, removes every revision, retains only usage accounting", async () => {
  const sql = new Database(":memory:");
  sql.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE project(id TEXT PRIMARY KEY,user_id TEXT,status TEXT,source_key TEXT,upload_id TEXT,updated_at INTEGER);
    CREATE TABLE clip(id TEXT PRIMARY KEY,project_id TEXT REFERENCES project(id) ON DELETE CASCADE,user_id TEXT);
    CREATE TABLE render_job(id TEXT,clip_id TEXT,user_id TEXT,status TEXT);
    CREATE TABLE word(project_id TEXT REFERENCES project(id) ON DELETE CASCADE,text TEXT);
    CREATE TABLE inference_spend(project_id TEXT, minutes INTEGER);`);
  const one = "11111111-1111-4111-8111-111111111111";
  const two = "22222222-2222-4222-8222-222222222222";
  for (const [id, user] of [[one, "owner"], [two, "other"]]) {
    sql.prepare("INSERT INTO project VALUES (?,?,'ready',?,NULL,0)").run(id, user, `users/${user}/sources/${id}/original`);
    sql.prepare("INSERT INTO clip VALUES (?,?,?)").run(id, id, user);
    sql.prepare("INSERT INTO render_job VALUES (?,?,?,'ready')").run(id, id, user);
    sql.prepare("INSERT INTO word VALUES (?,?)").run(id, "private speech");
    sql.prepare("INSERT INTO inference_spend VALUES (?,1)").run(id);
  }
  const keys = new Set([
    `users/owner/sources/${one}/original`, `users/owner/audio/${one}/manifest.json`,
    `users/owner/audio/${one}/chunk-000.mp3`, `users/owner/audio/${one}/chunk-001.mp3`,
    `users/owner/transcripts/${one}/chunk-000.json`, `users/owner/outputs/${one}/revision-1.mp4`,
    `users/owner/outputs/${one}/revision-2.mp4`, `users/other/sources/${two}/original`,
  ]);
  const db = { prepare: (query: string) => ({ bind: (...values: unknown[]) => ({
    run: async () => ({ meta: { changes: sql.prepare(query).run(...values as any[]).changes } }),
    first: async () => sql.prepare(query).get(...values as any[]) ?? null,
    all: async () => ({ results: sql.prepare(query).all(...values as any[]) }),
  }) }), batch: async (items: Array<{ run: () => Promise<unknown> }>) => {
    sql.exec("BEGIN"); try { for (const item of items) await item.run(); sql.exec("COMMIT"); }
    catch (error) { sql.exec("ROLLBACK"); throw error; }
  } } as unknown as Parameters<typeof purgeProject>[0];
  let fail = true;
  const media = {
    resumeMultipartUpload: () => ({ abort: async () => {} }),
    list: async ({ prefix, cursor }: { prefix: string; cursor?: string }) => {
      const matches = [...keys].filter((key) => key.startsWith(prefix) && (!cursor || key > cursor)).sort();
      return { objects: matches.slice(0, 2).map((key) => ({ key })), truncated: matches.length > 2, cursor: matches[1] };
    },
    delete: async (batch: string[]) => {
      if (fail) { fail = false; throw new Error("temporary R2 failure"); }
      for (const key of batch) keys.delete(key);
    },
  } as unknown as Parameters<typeof purgeProject>[1];
  expect(await purgeProject(db, media, "owner", two)).toBe("missing");
  sql.prepare("UPDATE render_job SET status = 'running' WHERE id = ?").run(one);
  expect(await purgeProject(db, media, "owner", one)).toBe("busy");
  sql.prepare("UPDATE render_job SET status = 'ready' WHERE id = ?").run(one);
  await expect(purgeProject(db, media, "owner", one)).rejects.toThrow("temporary R2 failure");
  expect(sql.prepare("SELECT status FROM project WHERE id = ?").get(one)).toEqual({ status: "deleting" });
  expect(await purgeProject(db, media, "owner", one)).toBe("deleted");
  expect(keys).toEqual(new Set([`users/other/sources/${two}/original`]));
  expect(sql.prepare("SELECT COUNT(*) AS n FROM word WHERE project_id = ?").get(one)).toEqual({ n: 0 });
  expect(sql.prepare("SELECT COUNT(*) AS n FROM project WHERE id = ?").get(one)).toEqual({ n: 0 });
  expect(sql.prepare("SELECT SUM(minutes) AS n FROM inference_spend").get()).toEqual({ n: 2 });
  expect(await purgeProject(db, media, "owner", one)).toBe("missing");
  sql.close();
});

test("expired sources are hidden conservatively", () => {
  expect(projectExpired(Date.now() - 89 * 86_400_000)).toBe(false);
  expect(projectExpired(Date.now() - 91 * 86_400_000)).toBe(true);
});
