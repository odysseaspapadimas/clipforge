// Offline-only Vite alias for cloudflare:workers. Never bundled in production.
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DatabaseSync } from "node:sqlite";
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { captionsForClip, discoverCandidates, sourceMinutes, type Word } from "../domain/media.ts";
import { grantPeriod, releaseMinutes, reserveMinutes } from "./credits.ts";

const root = resolve(process.cwd(), ".local-dev");
const mediaRoot = join(root, "media");
mkdirSync(mediaRoot, { recursive: true });
const sqlite = new DatabaseSync(join(root, "clipforge.sqlite"));
function transaction<T>(run: () => T): T {
  sqlite.exec("BEGIN");
  try { const value = run(); sqlite.exec("COMMIT"); return value; }
  catch (error) { sqlite.exec("ROLLBACK"); throw error; }
}
sqlite.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS _dev_migrations (name TEXT PRIMARY KEY)");
for (const name of readdirSync(resolve(process.cwd(), "drizzle")).filter((name) => name.endsWith(".sql")).sort()) {
  if (sqlite.prepare("SELECT 1 FROM _dev_migrations WHERE name = ?").get(name)) continue;
  transaction(() => {
    for (const statement of readFileSync(resolve(process.cwd(), "drizzle", name), "utf8").split("--> statement-breakpoint")) {
      if (statement.trim()) sqlite.exec(statement);
    }
    sqlite.prepare("INSERT INTO _dev_migrations VALUES (?)").run(name);
  });
}
const statement = (sql: string, values: unknown[] = []): any => ({
  bind: (...next: unknown[]) => statement(sql, next),
  first: async () => sqlite.prepare(sql).get(...values as any[]) ?? null,
  all: async () => ({ results: sqlite.prepare(sql).all(...values as any[]) }),
  raw: async () => sqlite.prepare(sql).all(...values as any[]).map((row: any) => Object.values(row)),
  run: async () => statement(sql, values).runSync(),
  runSync: () => { const result = sqlite.prepare(sql).run(...values as any[]); return { success: true, results: [], meta: { changes: result.changes } }; },
});
const DB = {
  prepare: (sql: string) => statement(sql),
  exec: async (sql: string) => { sqlite.exec(sql); return { count: 1, duration: 0 }; },
  batch: async (statements: Array<{ runSync: () => unknown }>) => transaction(() => statements.map((item) => item.runSync())),
} as unknown as D1Database;

function mediaPath(key: string) {
  if (!/^users\/[0-9A-Za-z_-]+\/[a-zA-Z0-9/._-]+$/.test(key) || key.includes("..")) throw new Error("Invalid media path");
  return join(mediaRoot, key);
}
function info(key: string) {
  const path = mediaPath(key);
  if (!existsSync(path)) return null;
  const stat = statSync(path);
  return { key, size: stat.size, httpMetadata: { contentType: key.endsWith(".mp4") ? "video/mp4" : "application/octet-stream" } };
}
const MEDIA = {
  head: async (key: string) => info(key),
  get: async (key: string, options?: { range?: { offset: number; length?: number } }) => {
    const meta = info(key); if (!meta) return null;
    const offset = options?.range?.offset ?? 0;
    const length = options?.range?.length ?? meta.size - offset;
    const nodeStream = createReadStream(mediaPath(key), { start: offset, end: offset + length - 1 });
    return { ...meta, body: Readable.toWeb(nodeStream) as unknown as ReadableStream,
      json: async () => JSON.parse(await readFile(mediaPath(key), "utf8")), text: async () => readFile(mediaPath(key), "utf8") };
  },
  put: async (key: string, input: string | ReadableStream) => {
    const path = mediaPath(key);
    await mkdir(resolve(path, ".."), { recursive: true });
    if (typeof input === "string") await writeFile(path, input);
    else await pipeline(Readable.fromWeb(input as any), createWriteStream(path));
    return info(key);
  },
  delete: async (key: string) => { await rm(mediaPath(key), { force: true }); },
  createMultipartUpload: async (key: string) => ({ key, uploadId: crypto.randomUUID() }),
  resumeMultipartUpload: (key: string, uploadId: string) => ({
    uploadPart: async (partNumber: number, value: ReadableStream) => {
      const path = mediaPath(`${key}.parts/${uploadId}/${partNumber}`);
      await mkdir(resolve(path, ".."), { recursive: true });
      await pipeline(Readable.fromWeb(value as any), createWriteStream(path));
      return { partNumber, etag: `dev-${uploadId}-${partNumber}` };
    },
    complete: async (parts: Array<{ partNumber: number }>) => {
      const path = mediaPath(key);
      await mkdir(resolve(path, ".."), { recursive: true });
      const output = createWriteStream(path);
      for (const part of parts) {
        const source = mediaPath(`${key}.parts/${uploadId}/${part.partNumber}`);
        for await (const chunk of createReadStream(source)) { if (!output.write(chunk)) await new Promise((resolve) => output.once("drain", resolve)); }
      }
      await new Promise<void>((resolve, reject) => output.end((error?: Error) => error ? reject(error) : resolve()));
      await rm(mediaPath(`${key}.parts/${uploadId}`), { recursive: true, force: true });
      return info(key);
    },
    abort: async () => { await rm(mediaPath(`${key}.parts/${uploadId}`), { recursive: true, force: true }); },
  }),
} as unknown as R2Bucket;

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let output = "", error = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { error += chunk.toString().slice(-2000); });
    child.on("exit", (code) => code === 0 ? resolve(output) : reject(new Error(error)));
    child.on("error", reject);
  });
}
// The sample transcript is strictly a local integration fixture. It does not impersonate provider output in production.
const SAMPLE = "Every long conversation has one moment that changes how you see the whole story. The first time we tried this idea we were sure it would fail. But then a listener asked a question nobody expected. Why do we keep the best stories locked inside two hour recordings? That question made us rethink everything. A great clip is not about making a conversation shorter. It is about giving one important thought enough room to travel. Start with a real question, leave room for the answer, and let the person speaking sound like themselves.";
async function localIngest(projectId: string) {
  const project = await DB.prepare("SELECT * FROM project WHERE id = ?").bind(projectId).first<{ id: string; user_id: string; source_key: string; status: string }>();
  if (!project || project.status === "ready") return;
  try {
    const raw = JSON.parse(await run("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", mediaPath(project.source_key)]));
    const video = raw.streams.find((stream: any) => stream.codec_type === "video");
    const audio = raw.streams.some((stream: any) => stream.codec_type === "audio");
    if (!video || !audio) throw new Error("The recording must contain audio and video.");
    const durationMs = Math.round(Number(raw.format.duration) * 1000);
    const minutes = sourceMinutes(durationMs);
    if (!await reserveMinutes(DB, project.user_id, projectId, minutes)) throw new Error("Not enough source minutes for this recording.");
    await DB.prepare("UPDATE project SET status='processing',duration_ms=?,width=?,height=?,updated_at=? WHERE id=?")
      .bind(durationMs, video.width, video.height, Date.now(), projectId).run();
    const tokens = SAMPLE.split(/\s+/);
    const sampleWords: Word[] = Array.from({ length: Math.min(240, Math.max(20, Math.floor(durationMs / 550))) }, (_, index) => ({
      text: tokens[index % tokens.length], startMs: Math.floor(index * durationMs / Math.min(240, Math.max(20, Math.floor(durationMs / 550)))),
      endMs: Math.floor((index + .7) * durationMs / Math.min(240, Math.max(20, Math.floor(durationMs / 550)))),
      speaker: 0, confidence: 1,
    }));
    for (const [index, word] of sampleWords.entries()) await DB.prepare("INSERT OR REPLACE INTO word VALUES (?,?,?,?,?,?,?)")
      .bind(projectId, index, word.text, word.startMs, word.endMs, word.speaker, 1000).run();
    const candidates = discoverCandidates(sampleWords, durationMs, 3);
    for (const item of candidates) await DB.prepare(`INSERT INTO clip (id,project_id,user_id,title,start_ms,end_ms,crop_x,crop_y,zoom,captions,rationale,score,revision,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,500,500,1000,?,?,?,1,'draft',?,?)`)
      .bind(crypto.randomUUID(), projectId, project.user_id, item.title, item.startMs, item.endMs,
        JSON.stringify(captionsForClip(sampleWords, item.startMs, item.endMs)), "LOCAL DEMO TRANSCRIPT — not real speech recognition", item.score, Date.now(), Date.now()).run();
    await DB.prepare("UPDATE project SET status='ready',updated_at=? WHERE id=?").bind(Date.now(), projectId).run();
  } catch (error) {
    console.error("offline ingest failed", String(error));
    await releaseMinutes(DB, project.user_id, projectId);
    await DB.prepare("UPDATE project SET status='failed',error=?,updated_at=? WHERE id=?")
      .bind(String(error), Date.now(), projectId).run();
  }
}
async function localExport(jobId: string) {
  const job = await DB.prepare(`SELECT j.id,j.clip_id,j.revision,c.user_id,c.project_id,c.start_ms,c.end_ms,c.crop_x,c.crop_y,c.zoom,c.captions,p.source_key
    FROM render_job j JOIN clip c ON c.id=j.clip_id JOIN project p ON p.id=c.project_id WHERE j.id=?`).bind(jobId).first<any>();
  if (!job) return;
  try {
    await DB.prepare("UPDATE render_job SET status='running',updated_at=? WHERE id=?").bind(Date.now(),jobId).run();
    const response = await fetch("http://127.0.0.1:8080/render", { method: "POST", headers: { "x-clipforge-render": JSON.stringify({
      startMs: job.start_ms,endMs: job.end_ms,cropX: job.crop_x,cropY: job.crop_y,zoom: job.zoom,captions: JSON.parse(job.captions),
    }) }, body: createReadStream(mediaPath(job.source_key)) as any, duplex: "half" } as RequestInit);
    if (!response.ok || !response.body) throw new Error(`Local renderer unavailable (${response.status}); run bun run dev:renderer`);
    const key = `users/${job.user_id}/outputs/${job.clip_id}/revision-${job.revision}.mp4`;
    await MEDIA.put(key, response.body as any);
    await DB.prepare("UPDATE render_job SET status='ready',updated_at=? WHERE id=?").bind(Date.now(),jobId).run();
    await DB.prepare("UPDATE clip SET status='ready',output_key=?,rendered_revision=?,updated_at=? WHERE id=? AND revision=?")
      .bind(key, job.revision, Date.now(), job.clip_id, job.revision).run();
  } catch (error) {
    console.error("offline export failed", String(error));
    await DB.prepare("UPDATE render_job SET status='failed',error=?,updated_at=? WHERE id=?")
      .bind(String(error), Date.now(), jobId).run();
  }
}
export const waitUntil = (promise: Promise<unknown>) => { void promise.catch((error) => console.error("local background task failed", String(error))); };
export const env = {
  DB, MEDIA,
  AUTH_SECRET: "local-demo-secret-only-never-use-in-production-0123456789",
  INTERNAL_SECRET: "local-demo-internal-secret-0123456789",
  EMAIL_API_KEY: "",
  EMAIL_FROM: "Clipforge <dev@localhost>",
  DEV_MODE: "true",
  APP_ORIGIN: process.env.CLIPFORGE_DEV_ORIGIN ?? "http://127.0.0.1:5173",
  PROCESSOR: { async fetch(request: Request) {
    const body = await request.json() as { projectId?: string; jobId?: string };
    if (new URL(request.url).pathname === "/internal/ingest" && body.projectId) {
      setTimeout(() => { void localIngest(body.projectId!); }, 200);
      return Response.json({ queued: true }, { status: 202 });
    }
    if (new URL(request.url).pathname === "/internal/export" && body.jobId) {
      setTimeout(() => { void localExport(body.jobId!); }, 200);
      return Response.json({ queued: true }, { status: 202 });
    }
    return new Response("Not found", { status: 404 });
  } },
  BILLING: { async fetch(request: Request) {
    const body = await request.json() as { userId: string };
    if (new URL(request.url).pathname === "/internal/checkout") {
      const invoiceId = `in_local${Date.now()}`;
      await DB.prepare("INSERT OR IGNORE INTO subscription(user_id,customer_id,subscription_id,status) VALUES (?,?,?,'none')")
        .bind(body.userId, `cus_local${body.userId}`, `sub_local${body.userId}`).run();
      await grantPeriod(DB, { userId: body.userId, subscriptionId: `sub_local${body.userId}`, invoiceId, minutes: 120,
        periodStart: Date.now(), periodEnd: Date.now() + 30 * 86_400_000 });
      return Response.json({ url: `${env.APP_ORIGIN}/studio?local-demo=1` });
    }
    return Response.json({ url: `${env.APP_ORIGIN}/studio?local-demo=1` });
  } },
};
