import { z } from "zod";

export const SEGMENT_MS = 60_000;
export const MAX_CHUNKS = 121;
export const chunkManifest = z.object({ type: z.literal("manifest"),
  durationMs: z.number().int().positive().max(7_200_000), width: z.number().int().positive().max(7680),
  height: z.number().int().positive().max(4320), chunkCount: z.number().int().min(1).max(MAX_CHUNKS),
  segmentMs: z.literal(SEGMENT_MS),
}).refine((data) => data.chunkCount === Math.ceil(data.durationMs / SEGMENT_MS) ||
  (data.durationMs % SEGMENT_MS < 500 && data.chunkCount === Math.ceil(data.durationMs / SEGMENT_MS) + 1),
  "Segment count does not match duration");
export type ChunkManifest = z.infer<typeof chunkManifest>;
export const chunkLine = z.object({ type: z.literal("chunk"), index: z.number().int().nonnegative().max(MAX_CHUNKS - 1),
  audio: z.string().min(120).max(2_000_000).regex(/^[A-Za-z0-9+/]+={0,2}$/),
});

/** Stream NDJSON without retaining a full recording or accepting an unbounded line. */
export async function* lines(body: ReadableStream<Uint8Array>, maxLine = 2_100_000): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      if (pending.length > maxLine * 2) throw new Error("Segment line exceeds limit");
      let end: number;
      while ((end = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, end);
        if (line.length > maxLine) throw new Error("Segment line exceeds limit");
        pending = pending.slice(end + 1);
        if (line) yield line;
      }
      if (pending.length > maxLine) throw new Error("Segment line exceeds limit");
      if (done) {
        if (pending) throw new Error("Unterminated segment line");
        return;
      }
    }
  } finally { await reader.cancel().catch(() => {}); }
}

export function decodeChunk(encoded: string): Uint8Array {
  const binary = atob(encoded);
  if (binary.length < 100 || binary.length > 1_500_000) throw new Error("Segment size outside bound");
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
