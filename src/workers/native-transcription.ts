import { getContainer } from "@cloudflare/containers";
import type { ProcessorEnv } from "../../alchemy.run.ts";
import { chunkLine, chunkManifest, decodeChunk, lines, SEGMENT_MS, type ChunkManifest } from "../domain/chunks.ts";
import { normalizeWords, transcriptionWord, type Word } from "../domain/media.ts";
import { deepgramResponse } from "../domain/transcript.ts";

const audioPrefix = (userId: string, projectId: string) => `users/${userId}/audio/${projectId}`;
export const segmentKey = (userId: string, projectId: string, index: number) =>
  `${audioPrefix(userId, projectId)}/chunk-${String(index).padStart(3, "0")}.mp3`;
export const transcriptSegmentKey = (userId: string, projectId: string, index: number) =>
  `users/${userId}/transcripts/${projectId}/chunk-${String(index).padStart(3, "0")}.json`;

/** FFmpeg is the sole source of segment metadata. Store each chunk before publishing the manifest. */
export async function prepareAudioChunks(env: ProcessorEnv, projectId: string, userId: string, sourceKey: string,
  slot: number): Promise<ChunkManifest> {
  const manifestKey = `${audioPrefix(userId, projectId)}/manifest.json`;
  const cached = await env.MEDIA.get(manifestKey);
  if (cached) return chunkManifest.parse(await cached.json());
  const source = await env.MEDIA.get(sourceKey);
  if (!source) throw new Error("source_missing");
  const container = getContainer(env.RENDER, `media-slot-${slot}`);
  const response = await container.fetch("http://container/prepare-chunks", {
    method: "POST", body: source.body, headers: { "content-type": "application/octet-stream" },
  });
  if (!response.ok || !response.body) throw new Error(`prepare_http_${response.status}`);
  let manifest: ChunkManifest | null = null;
  let seen = 0;
  for await (const line of lines(response.body)) {
    const item = JSON.parse(line) as unknown;
    if (!manifest) {
      manifest = chunkManifest.parse(item);
      continue;
    }
    const chunk = chunkLine.parse(item);
    if (chunk.index !== seen || seen >= manifest.chunkCount) throw new Error("Invalid segment ordering");
    const key = segmentKey(userId, projectId, seen);
    if (!await env.MEDIA.head(key)) {
      const audio = decodeChunk(chunk.audio);
      await env.MEDIA.put(key, audio.buffer as ArrayBuffer, { httpMetadata: { contentType: "audio/mpeg" } });
    }
    seen++;
  }
  if (!manifest || seen !== manifest.chunkCount) throw new Error("Incomplete audio segments");
  await env.MEDIA.put(manifestKey, JSON.stringify(manifest), { httpMetadata: { contentType: "application/json" } });
  return manifest;
}

/** Checkpoint one paid inference per chunk; no blind automatic retry after an uncertain response. */
async function boundedProviderJson(response: Response, maxBytes = 1_500_000) {
  const announced = Number(response.headers.get("content-length") ?? 0);
  if (announced > maxBytes || !response.body) throw new Error("transcript_chunk_oversized");
  const chunks: Uint8Array[] = [];
  const reader = response.body.getReader();
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error("transcript_chunk_oversized");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const raw = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)) as unknown;
}

/** External provider stays explicit and key-gated; it never silently takes over a failed Cloudflare call. */
export async function transcribeChunk(env: ProcessorEnv, projectId: string, userId: string, index: number,
  providerFetch: typeof fetch = fetch) {
  const outputKey = transcriptSegmentKey(userId, projectId, index);
  if (await env.MEDIA.head(outputKey)) return;
  const audio = await env.MEDIA.get(segmentKey(userId, projectId, index));
  if (!audio || audio.size > 1_500_000) throw new Error("audio_chunk_missing_or_oversized");
  const backend = env.TRANSCRIPTION_BACKEND ?? "workers-ai";
  let result: unknown;
  if (backend === "workers-ai") {
    result = await env.AI.run("@cf/deepgram/nova-3", {
      audio: { body: audio.body, contentType: "audio/mpeg" },
      language: "en", diarize: true, punctuate: true, smart_format: true,
    });
  } else if (backend === "deepgram") {
    const key = (env as ProcessorEnv & { DEEPGRAM_KEY?: string }).DEEPGRAM_KEY;
    if (!key) throw new Error("deepgram_key_missing");
    const url = new URL("https://api.deepgram.com/v1/listen");
    url.searchParams.set("model", "nova-3");
    url.searchParams.set("language", "en");
    url.searchParams.set("diarize", "true");
    url.searchParams.set("smart_format", "true");
    const response = await providerFetch(url, { method: "POST", headers: {
      authorization: `Token ${key}`, "content-type": "audio/mpeg",
    }, body: audio.body });
    if (!response.ok) throw new Error(`transcription_http_${response.status}`);
    result = await boundedProviderJson(response);
  } else throw new Error("unsupported_transcription_backend");
  const transcript = deepgramResponse.parse(result);
  const serialized = JSON.stringify(transcript);
  if (new TextEncoder().encode(serialized).byteLength > 1_500_000) throw new Error("transcript_chunk_oversized");
  await env.MEDIA.put(outputKey, serialized, { httpMetadata: { contentType: "application/json" } });
}

export async function mergeTranscriptChunks(env: ProcessorEnv, projectId: string, userId: string, manifest: ChunkManifest): Promise<Word[]> {
  const all: Word[] = [];
  for (let index = 0; index < manifest.chunkCount; index++) {
    const object = await env.MEDIA.get(transcriptSegmentKey(userId, projectId, index));
    if (!object || object.size > 1_500_000) throw new Error(`transcript_segment_missing_${index}`);
    const transcript = deepgramResponse.parse(await object.json());
    const offset = index * SEGMENT_MS;
    for (const item of transcript.results.channels[0].alternatives[0].words) {
      const endMs = Math.min(manifest.durationMs, offset + Math.round(item.end * 1000));
      all.push(transcriptionWord.parse({ text: item.punctuated_word ?? item.word,
        startMs: offset + Math.round(item.start * 1000), endMs,
        // Diarization identifiers are local to a chunk; never imply identity across chunk boundaries.
        speaker: item.speaker === undefined ? null : index * 16 + item.speaker,
        confidence: item.confidence ?? null }));
    }
  }
  return normalizeWords(all, manifest.durationMs);
}
