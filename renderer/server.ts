import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { buildAss, cropFilter, renderOptions } from "./captions.ts";

const MAX_BYTES = 5 * 1024 ** 3;
const MAX_DURATION_MS = 7_200_000;
const SEGMENT_SECONDS = 60;
const probeSchema = z.object({
  format: z.object({ duration: z.coerce.number().positive() }),
  streams: z.array(z.object({ codec_type: z.string(), width: z.number().optional(), height: z.number().optional() }).passthrough()),
});
async function processCommand(command: string, args: string[], timeoutMs: number): Promise<string> {
  const child = Bun.spawn([command, ...args], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  try {
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (exit !== 0) throw new Error(`${command} failed: ${stderr.slice(-500)}`);
    return stdout;
  } finally { clearTimeout(timer); }
}
async function inspect(file: string) {
  const parsed = probeSchema.parse(JSON.parse(await processCommand("ffprobe", ["-v", "error", "-show_entries",
    "format=duration:stream=codec_type,width,height", "-of", "json", file], 30_000)));
  const video = parsed.streams.find((stream) => stream.codec_type === "video" && stream.width && stream.height);
  const audio = parsed.streams.some((stream) => stream.codec_type === "audio");
  if (!video?.width || !video.height || !audio || video.width > 7680 || video.height > 4320 || parsed.format.duration * 1000 > MAX_DURATION_MS) {
    throw new Error("Unsupported video: requires video and audio, <=2 hours and <=8K input");
  }
  return { durationMs: Math.round(parsed.format.duration * 1000), width: video.width, height: video.height };
}
async function saveUpload(request: Request, path: string) {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_BYTES) throw new Error("Source exceeds size limit");
  const bytes = await Bun.write(path, request);
  if (bytes <= 0 || bytes > MAX_BYTES) throw new Error("Invalid source size");
}
async function streamedFile(filePath: string, dir: string, mime: string, metadata?: { durationMs: number; width: number; height: number }) {
  const file = Bun.file(filePath);
  const reader = file.stream().getReader();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const chunk = await reader.read();
      if (chunk.done) { controller.close(); await rm(dir, { recursive: true, force: true }); }
      else controller.enqueue(chunk.value);
    },
    async cancel() { await reader.cancel(); await rm(dir, { recursive: true, force: true }); },
  });
  const headers = new Headers({ "content-type": mime, "content-length": String(file.size) });
  if (metadata) {
    headers.set("x-clipforge-duration-ms", String(metadata.durationMs));
    headers.set("x-clipforge-width", String(metadata.width));
    headers.set("x-clipforge-height", String(metadata.height));
  }
  return new Response(stream, { headers });
}

Bun.serve({ port: Number(process.env.PORT ?? 8080), hostname: "0.0.0.0", idleTimeout: 255,
  async fetch(request, server) {
    const path = new URL(request.url).pathname;
    if (path === "/health") return Response.json({ ok: true });
    if (request.method !== "POST" || (path !== "/probe" && path !== "/prepare" && path !== "/prepare-chunks" && path !== "/render")) return new Response("Not found", { status: 404 });
    server.timeout(request, 0);
    const dir = await mkdtemp(join(tmpdir(), "clipforge-"));
    const input = join(dir, "source.media");
    try {
      await saveUpload(request, input);
      const metadata = await inspect(input);
      if (path === "/probe") {
        await rm(dir, { recursive: true, force: true });
        return Response.json(metadata);
      }
      if (path === "/prepare" || path === "/prepare-chunks") {
        const args = ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", input,
          "-map", "0:a:0", "-vn", "-ac", "1", "-codec:a", "libmp3lame", "-b:a", "64k"];
        if (path === "/prepare") {
          const output = join(dir, "speech.mp3");
          await processCommand("ffmpeg", [...args, output], 1_200_000);
          return streamedFile(output, dir, "audio/mpeg", metadata);
        }
        await processCommand("ffmpeg", [...args, "-f", "segment", "-segment_time", String(SEGMENT_SECONDS),
          "-reset_timestamps", "1", "-segment_format", "mp3", join(dir, "speech-%03d.mp3")], 1_200_000);
        const files = (await readdir(dir)).filter((name) => /^speech-\d{3}\.mp3$/.test(name)).sort();
        if (files.length < 1 || files.length > 121) throw new Error("Invalid audio segments");
        let index = -1;
        const stream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              index++;
              if (index === 0) {
                controller.enqueue(new TextEncoder().encode(JSON.stringify({ type: "manifest", ...metadata,
                  chunkCount: files.length, segmentMs: SEGMENT_SECONDS * 1000 }) + "\n"));
                return;
              }
              if (index > files.length) { controller.close(); await rm(dir, { recursive: true, force: true }); return; }
              const file = Bun.file(join(dir, files[index - 1]));
              if (file.size < 100 || file.size > 1_500_000) throw new Error("Audio segment out of bounds");
              const bytes = Buffer.from(await file.arrayBuffer());
              controller.enqueue(new TextEncoder().encode(JSON.stringify({ type: "chunk", index: index - 1,
                audio: bytes.toString("base64") }) + "\n"));
            } catch (error) { controller.error(error); await rm(dir, { recursive: true, force: true }); }
          },
          async cancel() { await rm(dir, { recursive: true, force: true }); },
        });
        return new Response(stream, { headers: { "content-type": "application/x-ndjson" } });
      }
      const raw = request.headers.get("x-clipforge-render");
      if (!raw || raw.length > 100_000) throw new Error("Invalid render options");
      const options = renderOptions.parse(JSON.parse(raw));
      if (options.endMs > metadata.durationMs + 300) throw new Error("Clip exceeds source duration");
      const subtitle = join(dir, "captions.ass");
      await Bun.write(subtitle, buildAss(options));
      const output = join(dir, "short.mp4");
      const preSeek = Math.max(0, options.startMs / 1000 - 5);
      const trim = options.startMs / 1000 - preSeek;
      const duration = (options.endMs - options.startMs) / 1000;
      const filter = `${cropFilter(metadata.width, metadata.height, options.cropX, options.cropY, options.zoom)},subtitles=${subtitle}`;
      await processCommand("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-y",
        "-ss", String(preSeek), "-i", input, "-ss", String(trim), "-t", String(duration),
        "-vf", filter, "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", output], 1_200_000);
      return streamedFile(output, dir, "video/mp4");
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      console.error("media operation failed", { operation: path, error: String(error) });
      return Response.json({ error: "Media processing failed" }, { status: 422 });
    }
  },
});
