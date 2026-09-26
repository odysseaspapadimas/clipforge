import { Container, getContainer } from "@cloudflare/containers";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { z } from "zod";
import type { ProcessorEnv } from "../../alchemy.run.ts";
import { captionsForClip, clipEdit, discoverCandidates, sourceMinutes, type Word } from "../domain/media.ts";
import { safeErrorCode } from "../domain/safe-error.ts";
import type { ChunkManifest } from "../domain/chunks.ts";
import { mergeTranscriptChunks, prepareAudioChunks, transcribeChunk } from "./native-transcription.ts";
import { releaseMinutes, reserveMinutes } from "../server/credits.ts";
import { claimStagingInferenceMinutes } from "../server/inference-budget.ts";
import { assertMediaSlot, releaseMediaSlot, waitForMediaSlot } from "../server/media-slots.ts";
import { MEDIA_RETENTION_MS, purgeProject } from "../server/project-retention.ts";
import { claimExportStart, claimIngestStart } from "../server/job-fences.ts";
import { storeRenderedMp4 } from "./render-output.ts";

export class RenderContainer extends Container { defaultPort = 8080; sleepAfter = "30s"; }
const retrySafe = { retries: { limit: 2, delay: "5 seconds", backoff: "exponential" }, timeout: "5 minutes" } as const;
// Cloudflare Workflows permits at most 30 minutes per step.
const noRetry = { retries: { limit: 0, delay: "1 second" }, timeout: "30 minutes" } as const;

function internal(request: Request, env: ProcessorEnv): boolean {
  return Boolean(env.INTERNAL_SECRET && request.headers.get("x-clipforge-internal") === env.INTERNAL_SECRET);
}
const sjson = (value: unknown, status = 200) => Response.json(value, { status });

/** Deterministic Workflow IDs make retried service calls safe after ambiguous responses. */
export async function ensureIngestWorkflow(env: Pick<ProcessorEnv, "DB" | "INGEST">, projectId: string) {
  const project = await env.DB.prepare("SELECT status FROM project WHERE id = ?")
    .bind(projectId).first<{ status: string }>();
  if (project?.status !== "queued" && project?.status !== "processing") throw new Error("project_not_queued");
  const id = `ingest-${projectId}`;
  try {
    const instance = await env.INGEST.create({ id, params: { projectId } });
    return instance.id;
  } catch {
    // Creating an existing ID and losing a successful create response have
    // the same safe outcome. An unavailable `get` must NOT be called success.
    const instance = await env.INGEST.get(id);
    const state = await instance.status();
    if (state.status === "errored" && project.status === "queued") await instance.restart();
    else if (!["queued", "running", "waiting", "waitingForPause", "paused"].includes(state.status)) {
      throw new Error("ingest_workflow_needs_reconciliation");
    }
    return instance.id;
  }
}

/** A queued export may be retried without creating a second Workflow. */
export async function ensureQueuedExportWorkflow(env: Pick<ProcessorEnv, "EXPORT">, jobId: string) {
  const id = `export-${jobId}`;
  try {
    const instance = await env.EXPORT.create({ id, params: { jobId } });
    return instance.id;
  } catch {
    const instance = await env.EXPORT.get(id);
    const state = await instance.status();
    if (state.status === "errored" || state.status === "terminated") await instance.restart();
    else if (!["queued", "running", "waiting", "waitingForPause", "paused"].includes(state.status)) {
      throw new Error("export_workflow_needs_reconciliation");
    }
    return instance.id;
  }
}

/** Process a small bounded batch each hour, including accounts that never sign in again. */
export async function sweepExpiredProjects(env: Pick<ProcessorEnv, "DB" | "MEDIA">, now = Date.now()): Promise<number> {
  await env.DB.prepare("DELETE FROM upload_admission WHERE created_at < ?")
    .bind(now - 7 * 24 * 60 * 60 * 1000).run();
  const result = await env.DB.prepare(`SELECT id,user_id FROM project
    WHERE created_at < ? AND status IN ('uploading','ready','failed','deleting')
    ORDER BY updated_at,id LIMIT 16`)
    .bind(now - MEDIA_RETENTION_MS - 24 * 60 * 60 * 1000).all<{ id: string; user_id: string }>();
  let removed = 0;
  for (const project of result.results) {
    if (removed >= 2) break;
    try {
      const outcome = await purgeProject(env.DB, env.MEDIA, project.user_id, project.id);
      if (outcome === "deleted") { removed++; continue; }
      if (outcome === "missing") continue;
      // Busy jobs must not pin the first page forever. Rotate them behind
      // other eligible owners; the next hourly sweep can retry.
      await env.DB.prepare("UPDATE project SET updated_at = ? WHERE id = ? AND user_id = ?")
        .bind(now, project.id, project.user_id).run();
    } catch (error) {
      await env.DB.prepare("UPDATE project SET updated_at = ? WHERE id = ? AND user_id = ?")
        .bind(now, project.id, project.user_id).run();
      console.error("retention sweep failed", { projectId: project.id, code: safeErrorCode(error) });
    }
  }
  return removed;
}

/** Only a positively terminal Workflow can unlock its claimed job for retry/deletion. */
export async function reconcileExportTerminal(env: Pick<ProcessorEnv, "DB" | "EXPORT">, jobId: string,
  now = Date.now()): Promise<"failed" | "active" | "unknown"> {
  // A failed lookup, or status `unknown`, is not proof work stopped: leave
  // `running` fenced against deleting its source and alert an operator.
  const instance = await env.EXPORT.get(`export-${jobId}`);
  const state = await instance.status();
  if (state.status === "errored" || state.status === "terminated" || state.status === "complete") {
    const result = await env.DB.prepare(`UPDATE render_job SET status = 'failed',
      error = ?,updated_at = ? WHERE id = ? AND status = 'running'`)
      .bind(state.status === "complete" ? "Export publication needs support; you can delete this source." :
        "Export stopped before publishing. Retry the export or delete this source.", now, jobId).run();
    if (state.status === "complete") console.error("completed export remained running", { jobId });
    return result.meta.changes === 1 ? "failed" : "active";
  }
  return state.status === "unknown" ? "unknown" : "active";
}

/** Inspect stale running jobs in rotating bounded batches; never infer terminal state from elapsed time. */
export async function reconcileFailedExports(env: Pick<ProcessorEnv, "DB" | "EXPORT">, now = Date.now()): Promise<number> {
  const result = await env.DB.prepare(`SELECT id FROM render_job WHERE status = 'running'
    AND updated_at < ? ORDER BY updated_at,id LIMIT 8`)
    .bind(now - 5 * 60_000).all<{ id: string }>();
  let failed = 0;
  for (const { id } of result.results) {
    try {
      const outcome = await reconcileExportTerminal(env, id, now);
      if (outcome === "failed") { failed++; continue; }
      if (outcome === "unknown") console.error("running export Workflow status unknown; keeping source fenced", { jobId: id });
    } catch (error) {
      console.error("running export status unavailable; keeping source fenced", { jobId: id, code: safeErrorCode(error) });
    }
    // Rotate live/unknown jobs so a few stalled oldest cannot starve others.
    await env.DB.prepare("UPDATE render_job SET updated_at = ? WHERE id = ? AND status = 'running'")
      .bind(now, id).run();
  }
  return failed;
}

export async function reconcileFailedIngests(env: Pick<ProcessorEnv, "DB" | "INGEST">, now = Date.now()): Promise<number> {
  const result = await env.DB.prepare(`SELECT id,user_id FROM project
    WHERE status = 'processing' AND updated_at < ? ORDER BY updated_at LIMIT 2`)
    .bind(now - 24 * 60 * 60 * 1000).all<{ id: string; user_id: string }>();
  let failed = 0;
  for (const project of result.results) {
    try {
      const workflow = await env.INGEST.get(`ingest-${project.id}`);
      const state = await workflow.status();
      if (state.status !== "errored" && state.status !== "terminated") continue;
      // Refund first: a crash before the status update will retry an idempotent
      // release next hour. Do not refund a running, waiting or unknown Workflow.
      await releaseMinutes(env.DB, project.user_id, project.id);
      const updated = await env.DB.prepare(`UPDATE project SET status = 'failed',
        error = 'Processing stopped. Your source minutes were returned.', updated_at = ?
        WHERE id = ? AND user_id = ? AND status = 'processing'`)
        .bind(now, project.id, project.user_id).run();
      failed += updated.meta.changes;
    } catch (error) {
      console.error("ingest reconciliation failed", { projectId: project.id, code: safeErrorCode(error) });
    }
  }
  return failed;
}

/** Recover lost Worker-service responses; expire a queue after 24h without charging minutes. */
export async function recoverQueuedStarts(env: Pick<ProcessorEnv, "DB" | "INGEST" | "EXPORT">, now = Date.now()) {
  const stale = now - 5 * 60 * 1000;
  const expired = now - 24 * 60 * 60 * 1000;
  const ingests = await env.DB.prepare(`SELECT id,COALESCE(queued_at,updated_at) AS queued_at FROM project
    WHERE status = 'queued' AND updated_at < ? ORDER BY updated_at,id LIMIT 8`)
    .bind(stale).all<{ id: string; queued_at: number }>();
  const exports = await env.DB.prepare(`SELECT j.id,COALESCE(j.queued_at,j.updated_at) AS queued_at FROM render_job j
    JOIN clip c ON c.id = j.clip_id AND c.user_id = j.user_id
    JOIN project p ON p.id = c.project_id AND p.user_id = j.user_id
    WHERE j.status = 'queued' AND j.updated_at < ? AND p.status = 'ready'
    ORDER BY j.updated_at,j.id LIMIT 8`)
    .bind(stale).all<{ id: string; queued_at: number }>();
  let retried = 0;
  let timedOut = 0;
  for (const item of ingests.results) {
    if (item.queued_at < expired) {
      const result = await env.DB.prepare(`UPDATE project SET status = 'failed',
        error = 'Processing could not start; no source minutes were charged.',updated_at = ?
        WHERE id = ? AND status = 'queued'`).bind(now, item.id).run();
      timedOut += result.meta.changes;
      continue;
    }
    try { await ensureIngestWorkflow(env, item.id); retried++; }
    catch (error) { console.error("queued ingest start deferred", { projectId: item.id, code: safeErrorCode(error) }); }
    await env.DB.prepare(`UPDATE project SET updated_at = ?,queued_at = COALESCE(queued_at,?)
      WHERE id = ? AND status = 'queued'`).bind(now, item.queued_at, item.id).run();
  }
  for (const item of exports.results) {
    if (item.queued_at < expired) {
      const result = await env.DB.prepare(`UPDATE render_job SET status = 'failed',
        error = 'Export could not start; retry it from the editor.',updated_at = ?
        WHERE id = ? AND status = 'queued'`).bind(now, item.id).run();
      timedOut += result.meta.changes;
      continue;
    }
    try { await ensureQueuedExportWorkflow(env, item.id); retried++; }
    catch (error) { console.error("queued export start deferred", { jobId: item.id, code: safeErrorCode(error) }); }
    await env.DB.prepare(`UPDATE render_job SET updated_at = ?,queued_at = COALESCE(queued_at,?)
      WHERE id = ? AND status = 'queued'`).bind(now, item.queued_at, item.id).run();
  }
  return { retried, timedOut };
}

export default {
  async scheduled(_event: ScheduledEvent, env: ProcessorEnv, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(Promise.allSettled([
      sweepExpiredProjects(env), reconcileFailedIngests(env), recoverQueuedStarts(env), reconcileFailedExports(env),
    ]).then(([retention, ingest, queued, exports]) => {
      for (const [name, result] of [["retention", retention], ["ingest", ingest], ["queued", queued], ["exports", exports]] as const) {
        if (result.status === "rejected") console.error("scheduled maintenance failed", {
          task: name, code: safeErrorCode(result.reason),
        });
      }
      console.info("scheduled maintenance completed", {
        removed: retention.status === "fulfilled" ? retention.value : null,
        reconciled: ingest.status === "fulfilled" ? ingest.value : null,
        retriedStarts: queued.status === "fulfilled" ? queued.value : null,
        terminalExports: exports.status === "fulfilled" ? exports.value : null,
      });
    }));
  },
  async fetch(request: Request, env: ProcessorEnv): Promise<Response> {
    if (!internal(request, env)) return new Response("Not found", { status: 404 });
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const url = new URL(request.url);
    if (url.pathname === "/internal/ingest") {
      const parsed = z.object({ projectId: z.string().uuid() }).safeParse(await request.json());
      if (!parsed.success) return sjson({ error: "Invalid project" }, 400);
      try { return sjson({ instanceId: await ensureIngestWorkflow(env, parsed.data.projectId) }, 202); }
      catch (error) {
        console.error("ingest start failed", { projectId: parsed.data.projectId, code: safeErrorCode(error) });
        return sjson({ error: "Ingest could not start; retry later or cancel the queued upload" }, 503);
      }
    }
    if (url.pathname === "/internal/export") {
      const parsed = z.object({ jobId: z.string().uuid() }).safeParse(await request.json());
      if (!parsed.success) return sjson({ error: "Invalid job" }, 400);
      const job = await env.DB.prepare(`SELECT j.status,j.revision,c.revision AS current_revision,p.status AS project_status
        FROM render_job j JOIN clip c ON c.id = j.clip_id AND c.user_id = j.user_id
        JOIN project p ON p.id = c.project_id AND p.user_id = j.user_id WHERE j.id = ?`)
        .bind(parsed.data.jobId).first<{ status: string; revision: number; current_revision: number; project_status: string }>();
      if (!job || job.revision !== job.current_revision || job.project_status !== "ready") return sjson({ error: "Job no longer matches an active project" }, 409);
      if (job.status === "queued") {
        try { return sjson({ instanceId: await ensureQueuedExportWorkflow(env, parsed.data.jobId) }, 202); }
        catch (error) {
          console.error("queued export start failed", { jobId: parsed.data.jobId, code: safeErrorCode(error) });
          return sjson({ error: "Export could not start; retry later or delete the source" }, 503);
        }
      }
      if (job.status === "failed") {
        const restartAt = Date.now();
        const claim = await env.DB.prepare(`UPDATE render_job SET status = 'queued',error = NULL,queued_at = ?,updated_at = ?
          WHERE id = ? AND status = 'failed' AND EXISTS
          (SELECT 1 FROM clip c JOIN project p ON p.id = c.project_id AND p.user_id = render_job.user_id
            WHERE c.id = render_job.clip_id AND c.user_id = render_job.user_id
              AND c.revision = render_job.revision AND p.status = 'ready')`)
          .bind(restartAt, restartAt, parsed.data.jobId).run();
        if (claim.meta.changes !== 1) return sjson({ error: "Export changed; refresh to retry" }, 409);
        try { return sjson({ instanceId: await ensureQueuedExportWorkflow(env, parsed.data.jobId) }, 202); }
        catch (error) {
          console.error("export retry deferred", { jobId: parsed.data.jobId, code: safeErrorCode(error) });
          return sjson({ error: "Export retry could not start; try again later" }, 503);
        }
      }
      if (job.status === "running") {
        try {
          const outcome = await reconcileExportTerminal(env, parsed.data.jobId);
          if (outcome === "failed") return sjson({ error: "Export stopped. Refresh to retry, or delete this project." }, 409);
          if (outcome === "unknown") return sjson({ error: "Export status is unknown; retry checking later, or contact support" }, 503);
          return sjson({ status: "running" }, 202);
        } catch (error) {
          console.error("export status check failed", { jobId: parsed.data.jobId, code: safeErrorCode(error) });
          return sjson({ error: "Export status unavailable; retry checking later" }, 503);
        }
      }
      return sjson({ error: "Export is already complete" }, 409);
    }
    return new Response("Not found", { status: 404 });
  },
};

async function persistTranscript(env: ProcessorEnv, project: { id: string; user_id: string; duration_ms: number }, manifest: ChunkManifest) {
  const words: Word[] = await mergeTranscriptChunks(env, project.id, project.user_id, manifest);
  if (words.length < 10) throw new Error("insufficient_speech");
  // D1 permits at most 100 bound values per statement: 14 words × 7 fields = 98.
  for (let from = 0; from < words.length; from += 14 * 25) {
    const statements = [];
    for (let index = from; index < Math.min(words.length, from + 14 * 25); index += 14) {
      const batch = words.slice(index, index + 14);
      statements.push(env.DB.prepare(`INSERT OR REPLACE INTO word (project_id,word_index,text,start_ms,end_ms,speaker,confidence) VALUES ${batch.map(() => "(?,?,?,?,?,?,?)").join(",")}`)
        .bind(...batch.flatMap((word, offset) => [project.id, index + offset, word.text, word.startMs, word.endMs,
          word.speaker, word.confidence === null ? null : Math.round(word.confidence * 1000)])));
    }
    await env.DB.batch(statements);
  }
  const suggestions = discoverCandidates(words, project.duration_ms, 20);
  const ranked = await rankCandidates(env, suggestions, words);
  let published = 0;
  for (const item of ranked) {
    const candidateCaptions = captionsForClip(words, item.startMs, item.endMs);
    // Reject invalid windows before publishing an uneditable/unexportable suggestion.
    if (!clipEdit.safeParse({ ...item, cropX: 500, cropY: 500, zoom: 1000,
      captions: candidateCaptions, revision: 1 }).success) continue;
    const clipId = crypto.randomUUID();
    await env.DB.prepare(`INSERT OR IGNORE INTO clip (id,project_id,user_id,title,start_ms,end_ms,crop_x,crop_y,zoom,captions,rationale,score,revision,status,created_at,updated_at)
      SELECT ?,?,?,?,?,?,500,500,1000,?,?,?,1,'draft',?,? WHERE NOT EXISTS
      (SELECT 1 FROM clip WHERE project_id = ? AND start_ms = ? AND end_ms = ?)`)
      .bind(clipId, project.id, project.user_id, item.title, item.startMs, item.endMs,
        JSON.stringify(candidateCaptions), item.rationale, item.score,
        Date.now(), Date.now(), project.id, item.startMs, item.endMs).run();
    published++;
  }
  if (!published) throw new Error("no_usable_candidates");
  return { words: words.length, clips: published };
}

export async function rankCandidates(env: ProcessorEnv, suggestions: ReturnType<typeof discoverCandidates>, words: Word[]) {
  if (suggestions.length <= 8) return suggestions;
  // Compact transcript excerpts and a strict ID allowlist constrain model cost and hallucinated timestamps.
  const options = suggestions.map((item, id) => ({ id, excerpt: words.filter((word) =>
    word.startMs >= item.startMs && word.endMs <= Math.min(item.endMs, item.startMs + 20_000))
    .map((word) => word.text).join(" ").slice(0, 700) }));
  try {
    const response = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
      temperature: 0.2, max_tokens: 900, response_format: { type: "json_object" }, messages: [
        { role: "system", content: "For English podcast short clips, choose up to 8 passages with clear hooks and standalone context. Do not invent timestamps. Return JSON {picks:[{id,title,rationale}]} with only given IDs and concise titles." },
        { role: "user", content: JSON.stringify(options) },
      ],
    });
    const responseText = typeof response === "string" ? response : "response" in response ? response.response : "";
    const data = z.object({ picks: z.array(z.object({ id: z.number().int(), title: z.string().max(120), rationale: z.string().max(220) })).max(8) })
      .parse(JSON.parse(responseText));
    const selected = new Set<number>();
    const picks = data.picks.filter((pick) => pick.id >= 0 && pick.id < suggestions.length && !selected.has(pick.id) && selected.add(pick.id))
      .map((pick) => ({ ...suggestions[pick.id], title: pick.title.trim() || suggestions[pick.id].title,
        rationale: pick.rationale, score: suggestions[pick.id].score }));
    return picks.length ? picks : suggestions.slice(0, 8);
  } catch {
    return suggestions.slice(0, 8).map((item) => ({ ...item, rationale: "Transcript-based suggestion; AI ranking unavailable." }));
  }
}

export class IngestWorkflow extends WorkflowEntrypoint<ProcessorEnv, { projectId: string }> {
  override async run(event: WorkflowEvent<{ projectId: string }>, step: WorkflowStep) {
    const { projectId } = event.payload;
    const project = await this.env.DB.prepare("SELECT id,user_id,source_key,status,duration_ms,transcription_backend FROM project WHERE id = ?")
      .bind(projectId).first<{ id: string; user_id: string; source_key: string; status: string; duration_ms: number | null;
        transcription_backend: string | null }>();
    if (!project || !["queued", "processing", "ready"].includes(project.status)) throw new Error("project_not_ready");
    if (project.status === "ready") return { projectId, status: "ready" };
    if (project.status === "queued" && !await claimIngestStart(this.env.DB, projectId)) {
      throw new Error("project_cancelled_before_processing");
    }
    try {
      // Changing providers during a Workflow would silently merge incompatible chunk results.
      if (project.transcription_backend && project.transcription_backend !== this.env.TRANSCRIPTION_BACKEND) {
        throw new Error("transcription_backend_changed_during_project");
      }
      const manifest = await (async () => {
        const lease = await waitForMediaSlot(step, this.env.DB, `prepare-${projectId}`, "prepare");
        try {
          return await step.do("prepare-chunks-v4", noRetry, async () => {
            await assertMediaSlot(this.env.DB, lease);
            try { return await prepareAudioChunks(this.env, projectId, project.user_id, project.source_key, lease.slot); }
            catch (error) { throw new Error(safeErrorCode(error)); }
          });
        } finally {
          await step.do("release-prepare-slot-v1", retrySafe, () => releaseMediaSlot(this.env.DB, lease));
        }
      })();
      const minutes = sourceMinutes(manifest.durationMs);
      await step.do("reserve-v1", retrySafe, async () => {
        const reserved = await reserveMinutes(this.env.DB, project.user_id, projectId, minutes);
        if (!reserved) throw new Error("insufficient_minutes");
        await this.env.DB.prepare(`UPDATE project SET duration_ms = ?,width = ?,height = ?,transcript_chunks = ?,
          transcription_backend = ?,status = 'processing',updated_at = ? WHERE id = ?`)
          .bind(manifest.durationMs, manifest.width, manifest.height, manifest.chunkCount,
            this.env.TRANSCRIPTION_BACKEND, Date.now(), projectId).run();
      });
      await step.do("claim-staging-inference-v1", retrySafe, async () => {
        if (!await claimStagingInferenceMinutes(this.env.DB, projectId, minutes)) {
          throw new Error("staging_inference_budget_exhausted");
        }
      });
      for (let index = 0; index < manifest.chunkCount; index++) {
        await step.do(`transcribe-v3-${index}`, noRetry, async () => {
          try { await transcribeChunk(this.env, projectId, project.user_id, index); }
          catch (error) { throw new Error(safeErrorCode(error)); }
          await this.env.DB.prepare("UPDATE project SET transcript_chunks_done = ?,updated_at = ? WHERE id = ? AND transcript_chunks_done < ?")
            .bind(index + 1, Date.now(), projectId, index + 1).run();
        });
      }
      await step.do("candidates-v3", retrySafe, () => persistTranscript(this.env,
        { id: projectId, user_id: project.user_id, duration_ms: manifest.durationMs }, manifest));
      await step.do("finish-v1", retrySafe, async () => {
        const completed = await this.env.DB.prepare("UPDATE project SET status = 'ready',error = NULL,updated_at = ? WHERE id = ? AND status = 'processing'")
          .bind(Date.now(), projectId).run();
        if (completed.meta.changes !== 1) throw new Error("project_no_longer_processing");
        return { done: true };
      });
      return { projectId, status: "ready" };
    } catch (error) {
      console.error("ingest failed", { projectId, code: safeErrorCode(error) });
      await releaseMinutes(this.env.DB, project.user_id, projectId);
      await this.env.DB.prepare("UPDATE project SET status = 'failed',error = ?,updated_at = ? WHERE id = ? AND status = 'processing'")
        .bind(String(error).includes("staging_inference_budget_exhausted")
          ? "Staging's shared transcription allowance is exhausted or this source exceeds 10 minutes. Your source minutes were returned."
          : "Processing failed. Your source minutes were returned; contact support or try another upload.", Date.now(), projectId).run();
      throw new Error(safeErrorCode(error));
    }
  }
}

export class ExportWorkflow extends WorkflowEntrypoint<ProcessorEnv, { jobId: string }> {
  override async run(event: WorkflowEvent<{ jobId: string }>, step: WorkflowStep) {
    const { jobId } = event.payload;
    const job = await this.env.DB.prepare(`SELECT j.id,j.clip_id,j.user_id,j.revision,j.status,c.project_id,c.start_ms,c.end_ms,c.crop_x,c.crop_y,c.zoom,c.captions,p.source_key
      FROM render_job j JOIN clip c ON c.id = j.clip_id AND c.user_id = j.user_id JOIN project p ON p.id = c.project_id AND p.user_id = j.user_id
      WHERE j.id = ? AND p.status = 'ready'`).bind(jobId).first<{ id: string; clip_id: string; user_id: string; revision: number; status: string;
        project_id: string; start_ms: number; end_ms: number; crop_x: number; crop_y: number; zoom: number; captions: string; source_key: string }>();
    if (!job) throw new Error("job_missing");
    if (job.status === "ready") return { jobId, status: "ready" };
    if (job.status === "queued" && !await claimExportStart(this.env.DB, jobId)) throw new Error("job_cancelled_before_render");
    if (job.status !== "queued" && job.status !== "running") throw new Error("job_not_runnable");
    const outputKey = `users/${job.user_id}/outputs/${job.clip_id}/revision-${job.revision}.mp4`;
    try {
      const lease = await waitForMediaSlot(step, this.env.DB, `render-${jobId}`, "render");
      try {
        await step.do("render-v2", noRetry, async () => {
          if (await this.env.MEDIA.head(outputKey)) return;
          await assertMediaSlot(this.env.DB, lease);
        const source = await this.env.MEDIA.get(job.source_key);
        if (!source) throw new Error("source_missing");
        const container = getContainer(this.env.RENDER, `media-slot-${lease.slot}`);
        const config = JSON.stringify({ startMs: job.start_ms, endMs: job.end_ms, cropX: job.crop_x,
          cropY: job.crop_y, zoom: job.zoom, captions: JSON.parse(job.captions) });
        const response = await container.fetch("http://container/render", { method: "POST", headers: {
          "content-type": "application/octet-stream", "x-clipforge-render": config,
        }, body: source.body });
        if (!response.ok || !response.body) throw new Error(`render_http_${response.status}`);
        await storeRenderedMp4(this.env.MEDIA, outputKey, response.body, response.headers.get("content-length"));
        });
      } finally {
        await step.do("release-render-slot-v1", retrySafe, () => releaseMediaSlot(this.env.DB, lease));
      }
      await step.do("publish-v1", retrySafe, async () => {
        await this.env.DB.batch([
          this.env.DB.prepare("UPDATE render_job SET status = 'ready',error = NULL,updated_at = ? WHERE id = ?").bind(Date.now(), jobId),
          this.env.DB.prepare("UPDATE clip SET status = 'ready',output_key = ?,rendered_revision = ?,updated_at = ? WHERE id = ? AND revision = ?")
            .bind(outputKey, job.revision, Date.now(), job.clip_id, job.revision),
        ]);
      });
      return { jobId, status: "ready" };
    } catch (error) {
      console.error("export failed", { jobId, code: safeErrorCode(error) });
      await this.env.DB.prepare("UPDATE render_job SET status = 'failed',error = 'Export failed; please retry.',updated_at = ? WHERE id = ? AND status = 'running'")
        .bind(Date.now(), jobId).run();
      throw new Error(safeErrorCode(error));
    }
  }
}
