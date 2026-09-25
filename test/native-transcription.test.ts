import { describe, expect, mock, test } from "bun:test";
import type { ProcessorEnv } from "../alchemy.run.ts";
import { chunkManifest, decodeChunk, lines } from "../src/domain/chunks.ts";
import { discoverCandidates } from "../src/domain/media.ts";
mock.module("@cloudflare/containers", () => ({ Container: class {}, getContainer: () => { throw new Error("No container in unit tests"); } }));
const { mergeTranscriptChunks, segmentKey, transcribeChunk } = await import("../src/workers/native-transcription.ts");

function fakeEnvironment() {
  const objects = new Map<string, Uint8Array>();
  let inferences = 0;
  const env = {
    MEDIA: {
      head: async (key: string) => objects.has(key) ? { size: objects.get(key)!.byteLength } : null,
      get: async (key: string) => {
        const bytes = objects.get(key);
        return bytes ? { size: bytes.length, body: new Blob([new Uint8Array(bytes)]).stream(),
          json: async () => JSON.parse(new TextDecoder().decode(bytes)) } : null;
      },
      put: async (key: string, payload: string | ArrayBuffer) => {
        objects.set(key, typeof payload === "string" ? new TextEncoder().encode(payload) : new Uint8Array(payload));
      },
    },
    AI: { run: async (_model: string, input: { audio: { body: ReadableStream<Uint8Array> } }) => {
      inferences++;
      expect((await new Response(input.audio.body).arrayBuffer()).byteLength).toBeGreaterThan(100);
      return { results: { channels: [{ alternatives: [{ words: Array.from({ length: 28 }, (_, index) => ({
        word: `word${index}`, start: 1 + index * 0.35, end: 1.25 + index * 0.35, speaker: 0,
      })) }] }] } };
    } },
  } as unknown as ProcessorEnv;
  return { env, objects, get inferences() { return inferences; } };
}

describe("real Cloudflare ASR boundary (offline contract; no inference billed)", () => {
  test("checks manifest and bounded segment decoding", () => {
    expect(chunkManifest.parse({ type: "manifest", durationMs: 120_500, width: 1280, height: 720,
      chunkCount: 3, segmentMs: 60_000 }).chunkCount).toBe(3);
    expect(() => chunkManifest.parse({ type: "manifest", durationMs: 120_500, width: 1280, height: 720,
      chunkCount: 20, segmentMs: 60_000 })).toThrow();
    expect(decodeChunk(btoa("a".repeat(150))).length).toBe(150);
  });
  test("parses lines across network boundaries and rejects an unterminated record", async () => {
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("{\"x\":1}\n{\"y"));
      controller.enqueue(new TextEncoder().encode("\":2}\n")); controller.close(); } });
    const received: string[] = [];
    for await (const line of lines(stream)) received.push(line);
    expect(received).toEqual(['{"x":1}', '{"y":2}']);
    const broken = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("incomplete")); controller.close(); } });
    await expect((async () => { for await (const _ of lines(broken)) {} })()).rejects.toThrow("Unterminated");
  });
  test("explicit Deepgram fallback uses the bounded 60-second source, not the long video", async () => {
    const fake = fakeEnvironment();
    const projectId = "fe23f344-c75e-4de6-b34d-3bc9bf816241", userId = "creator";
    fake.objects.set(segmentKey(userId, projectId, 0), new Uint8Array(512));
    (fake.env as unknown as { TRANSCRIPTION_BACKEND: string; DEEPGRAM_KEY: string }).TRANSCRIPTION_BACKEND = "deepgram";
    (fake.env as unknown as { DEEPGRAM_KEY: string }).DEEPGRAM_KEY = "unit-test-not-a-key";
    let calls = 0;
    const providerFetch = (async (input: RequestInfo | URL, options?: RequestInit) => {
      calls++;
      const url = new URL(String(input));
      expect(url.hostname).toBe("api.deepgram.com");
      expect(url.searchParams.get("model")).toBe("nova-3");
      expect(url.searchParams.get("diarize")).toBe("true");
      expect(new Headers(options?.headers).get("authorization")).toBe("Token unit-test-not-a-key");
      expect((await new Response(options?.body).arrayBuffer()).byteLength).toBe(512);
      return Response.json({ results: { channels: [{ alternatives: [{ words: [
        { word: "hello", start: 0.1, end: 0.4, speaker: 0 },
      ] }] }] } });
    }) as typeof fetch;
    await transcribeChunk(fake.env, projectId, userId, 0, providerFetch);
    await transcribeChunk(fake.env, projectId, userId, 0, providerFetch);
    expect(calls).toBe(1);
    expect(fake.inferences).toBe(0);
  });
  test("rejects oversized direct-provider transcripts before writing an object", async () => {
    const fake = fakeEnvironment();
    const projectId = "cb8ae90b-f25b-48f6-9906-e35654777a90", userId = "creator";
    fake.objects.set(segmentKey(userId, projectId, 0), new Uint8Array(512));
    (fake.env as unknown as { TRANSCRIPTION_BACKEND: string; DEEPGRAM_KEY: string }).TRANSCRIPTION_BACKEND = "deepgram";
    (fake.env as unknown as { DEEPGRAM_KEY: string }).DEEPGRAM_KEY = "unit-test-not-a-key";
    const providerFetch = (async () => new Response(new Uint8Array(1_500_001))) as unknown as typeof fetch;
    await expect(transcribeChunk(fake.env, projectId, userId, 0, providerFetch)).rejects.toThrow("transcript_chunk_oversized");
    expect(fake.objects.size).toBe(1);
  });
  test("transcribes chunk once, checkpoints provider response and merges absolute word times", async () => {
    const fake = fakeEnvironment();
    const projectId = "e9b420d7-143d-4f77-952d-20f7cf02a240", userId = "creator";
    fake.objects.set(segmentKey(userId, projectId, 0), new Uint8Array(512));
    fake.objects.set(segmentKey(userId, projectId, 1), new Uint8Array(512));
    await transcribeChunk(fake.env, projectId, userId, 0);
    await transcribeChunk(fake.env, projectId, userId, 0);
    await transcribeChunk(fake.env, projectId, userId, 1);
    expect(fake.inferences).toBe(2);
    const manifest = chunkManifest.parse({ type: "manifest", durationMs: 120_000, width: 1280,
      height: 720, chunkCount: 2, segmentMs: 60_000 });
    const words = await mergeTranscriptChunks(fake.env, projectId, userId, manifest);
    expect(words).toHaveLength(56);
    expect(words[28].startMs).toBe(61_000);
    expect(words[28].speaker).toBe(16);
    expect(discoverCandidates(words, 125_000).length).toBeGreaterThan(0);
  });
});
