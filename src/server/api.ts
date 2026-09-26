import { and, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";
import { clipEdit, uploadInput } from "../domain/media.ts";
import { safeErrorCode } from "../domain/safe-error.ts";
import { requireUser } from "./auth.ts";
import { balance } from "./credits.ts";
import { STAGING_TOTAL_INFERENCE_MINUTES } from "./inference-budget.ts";
import { env } from "./env.ts";
import { readJson } from "./json.ts";
import { clips, projects, subscriptions } from "./schema.ts";

const PART_BYTES = 32 * 1024 * 1024;
const uuid = z.string().uuid();
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "cache-control": "no-store" } });
const fail = (error: string, status: number) => json({ error }, status);
const db = () => drizzle(env.DB);
function publicProject(project: typeof projects.$inferSelect) {
  const { sourceKey: _sourceKey, uploadId: _uploadId, ...safe } = project;
  return safe;
}
function publicClip(clip: typeof clips.$inferSelect) {
  const { outputKey: _outputKey, ...safe } = clip;
  return safe;
}
const projectFor = async (userId: string, id: string) => {
  if (!uuid.safeParse(id).success) return null;
  return (await db().select().from(projects).where(and(eq(projects.id, id), eq(projects.userId, userId))).limit(1))[0] ?? null;
};
const clipFor = async (userId: string, id: string) => {
  if (!uuid.safeParse(id).success) return null;
  return (await db().select().from(clips).where(and(eq(clips.id, id), eq(clips.userId, userId))).limit(1))[0] ?? null;
};
async function startProcessor(path: string, payload: object) {
  const response = await env.PROCESSOR.fetch(new Request(`https://internal/internal/${path}`, {
    method: "POST", headers: { "content-type": "application/json", "x-clipforge-internal": env.INTERNAL_SECRET },
    body: JSON.stringify(payload),
  }));
  if (!response.ok) throw new Error(`Processor unavailable: ${response.status}`);
}
async function billing(path: string, user: { id: string; email: string }) {
  const response = await env.BILLING.fetch(new Request(`https://internal/internal/${path}`, {
    method: "POST", headers: { "content-type": "application/json", "x-clipforge-internal": env.INTERNAL_SECRET },
    body: JSON.stringify({ userId: user.id, email: user.email }),
  }));
  if (!response.ok) throw new Error(`Billing unavailable: ${response.status}`);
  return response.json();
}

async function mediaResponse(key: string, request: Request, mime: string, filename?: string) {
  const range = request.headers.get("range");
  let parsed: { offset: number; length?: number } | undefined;
  const meta = await env.MEDIA.head(key);
  if (!meta) return fail("Media unavailable", 404);
  if (range) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(range);
    if (!match) return new Response(null, { status: 416, headers: { "content-range": `bytes */${meta.size}` } });
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : Math.min(meta.size - 1, start + 8 * 1024 * 1024 - 1);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || end >= meta.size) {
      return new Response(null, { status: 416, headers: { "content-range": `bytes */${meta.size}` } });
    }
    parsed = { offset: start, length: end - start + 1 };
  }
  const object = await env.MEDIA.get(key, parsed ? { range: parsed } : undefined);
  if (!object) return fail("Media unavailable", 404);
  const headers = new Headers({ "content-type": mime, "cache-control": "private, no-store", "accept-ranges": "bytes",
    "content-length": String(parsed?.length ?? object.size), "x-content-type-options": "nosniff" });
  if (parsed) headers.set("content-range", `bytes ${parsed.offset}-${parsed.offset + parsed.length! - 1}/${object.size}`);
  if (filename) headers.set("content-disposition", `attachment; filename="${filename}"`);
  return new Response(object.body as ReadableStream, { status: parsed ? 206 : 200, headers });
}

export async function handleApi(request: Request): Promise<Response> {
  const user = await requireUser(request.headers);
  if (!user) return fail("Sign in required", 401);
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "api") return fail("Not found", 404);
  if (!["GET", "HEAD"].includes(request.method) && request.headers.get("origin") !== env.APP_ORIGIN) {
    return fail("Origin not allowed", 403);
  }
  const path = parts.slice(1);
  try {
    if (request.method === "GET" && path[0] === "me" && path.length === 1) {
      const subscription = (await db().select().from(subscriptions).where(eq(subscriptions.userId, user.id)).limit(1))[0] ?? null;
      const staging = String((env as typeof env & { STAGING_MODE?: string }).STAGING_MODE) === "true";
      const use = staging ? await env.DB.prepare("SELECT COALESCE(SUM(minutes),0) AS amount FROM inference_spend")
        .first<{ amount: number }>() : null;
      return json({ user, subscription: subscription ? { status: subscription.status, periodEnd: subscription.periodEnd } : null,
        minutes: await balance(env.DB, user.id), localDemo: String(env.DEV_MODE) === "true",
        stagingMinutesRemaining: staging ? Math.max(0, STAGING_TOTAL_INFERENCE_MINUTES - (use?.amount ?? 0)) : null });
    }
    if (request.method === "POST" && path[0] === "billing" && (path[1] === "checkout" || path[1] === "portal") && path.length === 2) {
      return json(await billing(path[1], user));
    }
    if (request.method === "GET" && path[0] === "projects" && path.length === 1) {
      const items = await db().select().from(projects).where(eq(projects.userId, user.id))
        .orderBy(desc(projects.createdAt)).limit(100);
      return json({ projects: items.map(publicProject) });
    }
    if (request.method === "POST" && path[0] === "uploads" && path.length === 1) {
      const parsed = uploadInput.safeParse(await readJson(request));
      if (!parsed.success) return fail("Choose an MP4, MOV or WebM under 5 GiB", 400);
      const subscription = (await db().select().from(subscriptions).where(eq(subscriptions.userId, user.id)).limit(1))[0];
      if (subscription?.status !== "active" || !subscription.periodEnd || subscription.periodEnd <= Date.now() ||
        await balance(env.DB, user.id) < 1) return fail("An active plan with remaining source minutes is required", 402);
      const active = await env.DB.prepare("SELECT COUNT(*) AS count FROM project WHERE user_id = ? AND status IN ('uploading','queued','processing')")
        .bind(user.id).first<{ count: number }>();
      if ((active?.count ?? 0) >= 2) return fail("Finish existing uploads before starting another", 429);
      const recent = await env.DB.prepare("SELECT COUNT(*) AS count FROM project WHERE user_id = ? AND created_at >= ?")
        .bind(user.id, Date.now() - 24 * 60 * 60 * 1000).first<{ count: number }>();
      if ((recent?.count ?? 0) >= 10) return fail("Daily upload limit reached", 429);
      const id = crypto.randomUUID();
      const sourceKey = `users/${user.id}/sources/${id}/original`;
      const multipart = await env.MEDIA.createMultipartUpload(sourceKey, { httpMetadata: { contentType: parsed.data.mimeType } });
      try {
        await db().insert(projects).values({ id, userId: user.id, title: parsed.data.name.replace(/\.[^.]+$/, ""),
          sourceKey, uploadId: multipart.uploadId, fileSize: parsed.data.size, mimeType: parsed.data.mimeType,
          createdAt: Date.now(), updatedAt: Date.now() });
      } catch (error) { await multipart.abort(); throw error; }
      return json({ projectId: id, partBytes: PART_BYTES, parts: Math.ceil(parsed.data.size / PART_BYTES) }, 201);
    }
    if (path[0] === "uploads" && path[1] && uuid.safeParse(path[1]).success) {
      const project = await projectFor(user.id, path[1]);
      if (!project) return fail("Not found", 404);
      if (request.method === "GET" && path.length === 2 && project.status === "uploading") {
        const uploaded = await env.DB.prepare("SELECT part_number AS partNumber, etag FROM upload_part WHERE project_id = ? ORDER BY part_number")
          .bind(project.id).all();
        return json({ projectId: project.id, name: project.title, size: project.fileSize,
          partBytes: PART_BYTES, parts: uploaded.results });
      }
      if (request.method === "PUT" && path[2] === "parts" && path[3] && path.length === 4) {
        if (project.status !== "uploading" || !project.uploadId || !request.body) return fail("Upload is closed", 409);
        const partNumber = Number(path[3]);
        const totalParts = Math.ceil(project.fileSize / PART_BYTES);
        if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > totalParts) return fail("Invalid part", 400);
        const expected = partNumber < totalParts ? PART_BYTES : project.fileSize - PART_BYTES * (totalParts - 1);
        const actual = Number(request.headers.get("content-length"));
        if (!Number.isSafeInteger(actual) || actual !== expected) return fail("Part size mismatch", 400);
        const multipart = env.MEDIA.resumeMultipartUpload(project.sourceKey, project.uploadId);
        // Cloudflare R2 needs a known-length stream; the local offline adapter accepts the original request stream.
        const uploaded = typeof FixedLengthStream === "undefined" ? await multipart.uploadPart(partNumber, request.body) :
          await (async () => {
            const fixed = new FixedLengthStream(expected);
            const sending = multipart.uploadPart(partNumber, fixed.readable);
            const [, part] = await Promise.all([request.body!.pipeTo(fixed.writable), sending]);
            return part;
          })();
        await env.DB.prepare("INSERT OR REPLACE INTO upload_part (project_id,part_number,etag,size) VALUES (?,?,?,?)")
          .bind(project.id, uploaded.partNumber, uploaded.etag, expected).run();
        return json({ partNumber: uploaded.partNumber, etag: uploaded.etag });
      }
      if (request.method === "POST" && path[2] === "complete" && path.length === 3) {
        if (project.status !== "uploading") {
          const previous = await env.MEDIA.head(project.sourceKey);
          if (previous?.size !== project.fileSize) return fail("Upload not complete", 409);
          if (project.status === "queued") await startProcessor("ingest", { projectId: project.id });
          return json({ projectId: project.id, status: project.status });
        }
        const totalParts = Math.ceil(project.fileSize / PART_BYTES);
        const uploaded = await env.DB.prepare("SELECT part_number AS partNumber,etag,size FROM upload_part WHERE project_id = ? ORDER BY part_number")
          .bind(project.id).all<{ partNumber: number; etag: string; size: number }>();
        if (uploaded.results.length !== totalParts || uploaded.results.some((part, index) =>
          part.partNumber !== index + 1 || part.size !== (index < totalParts - 1 ? PART_BYTES : project.fileSize - PART_BYTES * index))) {
          return fail("Missing upload parts", 400);
        }
        const existing = await env.MEDIA.head(project.sourceKey);
        const completed = existing ?? await env.MEDIA.resumeMultipartUpload(project.sourceKey, project.uploadId!).complete(
          uploaded.results.map(({ partNumber, etag }) => ({ partNumber, etag })));
        if (completed.size !== project.fileSize) {
          await env.MEDIA.delete(project.sourceKey);
          return fail("Uploaded file size did not match", 400);
        }
        await db().update(projects).set({ status: "queued", uploadId: null, updatedAt: Date.now() })
          .where(and(eq(projects.id, project.id), eq(projects.userId, user.id)));
        await startProcessor("ingest", { projectId: project.id });
        return json({ projectId: project.id, status: "queued" }, 202);
      }
      if (request.method === "DELETE" && path.length === 2) {
        if (project.status !== "uploading") return fail("Upload already submitted", 409);
        if (project.uploadId) await env.MEDIA.resumeMultipartUpload(project.sourceKey, project.uploadId).abort();
        await db().delete(projects).where(and(eq(projects.id, project.id), eq(projects.userId, user.id)));
        return json({ ok: true });
      }
    }
    if (path[0] === "projects" && path[1]) {
      const project = await projectFor(user.id, path[1]);
      if (!project) return fail("Not found", 404);
      if (request.method === "GET" && path.length === 2) {
        const projectClips = await db().select().from(clips).where(and(eq(clips.userId, user.id), eq(clips.projectId, project.id)))
          .orderBy(clips.startMs);
        const jobs = await env.DB.prepare(`SELECT j.id,j.clip_id AS clipId,j.revision,j.status,j.error FROM render_job j
          JOIN clip c ON c.id = j.clip_id WHERE c.project_id = ? AND j.user_id = ? ORDER BY j.created_at DESC LIMIT 100`)
          .bind(project.id, user.id).all();
        return json({ project: publicProject(project), clips: projectClips.map(publicClip), jobs: jobs.results });
      }
      if (request.method === "GET" && path[2] === "words" && path.length === 3) {
        const startMs = Math.max(0, Number(url.searchParams.get("startMs") ?? 0));
        const endMs = Math.min(project.durationMs ?? 0, Number(url.searchParams.get("endMs") ?? startMs + 180_000));
        if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs || endMs - startMs > 180_000) return fail("Invalid transcript range", 400);
        const rows = await env.DB.prepare("SELECT text,start_ms AS startMs,end_ms AS endMs,speaker FROM word WHERE project_id = ? AND start_ms >= ? AND end_ms <= ? ORDER BY word_index LIMIT 700")
          .bind(project.id, startMs, endMs).all();
        return json({ words: rows.results });
      }
      if (request.method === "GET" && path[2] === "media" && path.length === 3 && project.status !== "uploading") {
        return mediaResponse(project.sourceKey, request, project.mimeType);
      }
    }
    if (path[0] === "clips" && path[1]) {
      const clip = await clipFor(user.id, path[1]);
      if (!clip) return fail("Not found", 404);
      if (request.method === "PATCH" && path.length === 2) {
        const input = clipEdit.safeParse(await readJson(request));
        if (!input.success) return fail("Invalid clip edits", 400);
        const project = await projectFor(user.id, clip.projectId);
        if (!project?.durationMs || input.data.endMs > project.durationMs) return fail("Clip exceeds source duration", 400);
        const { revision, ...values } = input.data;
        const result = await env.DB.prepare(`UPDATE clip SET title = ?,start_ms = ?,end_ms = ?,crop_x = ?,crop_y = ?,zoom = ?,captions = ?,
          revision = revision + 1,status = 'draft',output_key = NULL,updated_at = ? WHERE id = ? AND user_id = ? AND revision = ?`)
          .bind(values.title, values.startMs, values.endMs, values.cropX, values.cropY, values.zoom,
            JSON.stringify(values.captions), Date.now(), clip.id, user.id, revision).run();
        if (result.meta.changes !== 1) return fail("This clip changed in another tab. Refresh to continue.", 409);
        return json({ revision: revision + 1 });
      }
      if (request.method === "POST" && path[2] === "export" && path.length === 3) {
        const project = await projectFor(user.id, clip.projectId);
        if (project?.status !== "ready") return fail("Source processing is not complete", 409);
        const subscription = (await db().select().from(subscriptions).where(eq(subscriptions.userId, user.id)).limit(1))[0];
        if (subscription?.status !== "active" || !subscription.periodEnd || subscription.periodEnd <= Date.now()) return fail("Active subscription required to export", 402);
        const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM render_job WHERE user_id = ? AND clip_id IN (SELECT id FROM clip WHERE project_id = ?)")
          .bind(user.id, project.id).first<{ count: number }>();
        if ((count?.count ?? 0) >= 20) return fail("Export limit reached for this source", 429);
        const jobId = crypto.randomUUID();
        await env.DB.prepare(`INSERT OR IGNORE INTO render_job (id,clip_id,user_id,revision,status,created_at,updated_at)
          VALUES (?,?,?,?,'queued',?,?)`).bind(jobId, clip.id, user.id, clip.revision, Date.now(), Date.now()).run();
        const job = await env.DB.prepare("SELECT id,status FROM render_job WHERE clip_id = ? AND revision = ? AND user_id = ?")
          .bind(clip.id, clip.revision, user.id).first<{ id: string; status: string }>();
        if (!job) throw new Error("Render job missing");
        if (job.status !== "ready") await startProcessor("export", { jobId: job.id });
        return json({ jobId: job.id, status: job.status }, 202);
      }
      if (request.method === "GET" && path[2] === "download" && path.length === 3) {
        if (!clip.outputKey || clip.status !== "ready" || clip.renderedRevision !== clip.revision) return fail("Export not ready", 409);
        return mediaResponse(clip.outputKey, request, "video/mp4", `clipforge-${clip.id}.mp4`);
      }
    }
    return fail("Not found", 404);
  } catch (error) {
    console.error("api failure", { method: request.method, route: path[0], code: safeErrorCode(error) });
    return fail("Request could not be completed. Please retry.", 500);
  }
}
