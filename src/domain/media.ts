import { z } from "zod";

export const MAX_UPLOAD_BYTES = 5 * 1024 ** 3;
export const MAX_DURATION_MS = 2 * 60 * 60 * 1000;
export const MAX_CLIP_MS = 180_000;
export const MIN_CLIP_MS = 8_000;
export const uploadInput = z.object({
  name: z.string().trim().min(1).max(180),
  size: z.number().int().positive().max(MAX_UPLOAD_BYTES),
  mimeType: z.enum(["video/mp4", "video/webm"]),
});
export const caption = z.object({
  text: z.string().trim().min(1).max(80),
  startMs: z.number().int().nonnegative(), endMs: z.number().int().positive(),
}).refine((value) => value.endMs > value.startMs, "Caption ends before it begins");
export const clipEdit = z.object({
  title: z.string().trim().min(1).max(120),
  startMs: z.number().int().nonnegative(), endMs: z.number().int().positive(),
  cropX: z.number().int().min(0).max(1000), cropY: z.number().int().min(0).max(1000),
  zoom: z.number().int().min(1000).max(2500),
  captions: z.array(caption).max(600), revision: z.number().int().positive(),
}).superRefine((value, context) => {
  if (value.endMs - value.startMs < MIN_CLIP_MS || value.endMs - value.startMs > MAX_CLIP_MS) {
    context.addIssue({ code: "custom", message: "Clip must be between 8 and 180 seconds", path: ["endMs"] });
  }
  let previousStart = value.startMs;
  for (const [index, item] of value.captions.entries()) {
    if (item.startMs < value.startMs || item.endMs > value.endMs || item.startMs < previousStart) {
      context.addIssue({ code: "custom", message: "Captions must be ordered by start time inside the clip", path: ["captions", index] });
    }
    previousStart = item.startMs;
  }
});
export type ClipEdit = z.infer<typeof clipEdit>;
export const transcriptionWord = z.object({
  text: z.string().min(1).max(100), startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(), speaker: z.number().int().nonnegative().nullable(),
  confidence: z.number().min(0).max(1).nullable(),
});
export type Word = z.infer<typeof transcriptionWord>;

export function normalizeWords(input: Word[], durationMs: number): Word[] {
  // Retain the original timing and every speaker, including speech wholly inside another word.
  // Overlaps are surfaced for correction in the editor rather than silently deleted.
  return [...input].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs).map((word) => {
    if (word.endMs <= word.startMs || word.endMs > durationMs + 2000) throw new Error("Invalid transcription timestamps");
    return word;
  });
}

export type SuggestedClip = { title: string; startMs: number; endMs: number; rationale: string; score: number };
/** Deterministic baseline: speaker/pause-delimited 30–85s windows, non-overlapping top selections. */
export function discoverCandidates(words: Word[], durationMs: number, max = 8): SuggestedClip[] {
  if (words.length === 0) return [];
  const windows: SuggestedClip[] = [];
  for (let start = 0; start < words.length; ) {
    let stop = start;
    // Test the *next* word before consuming it: a distant word must not bridge a short passage.
    while (stop + 1 < words.length) {
      const next = words[stop + 1];
      const gap = next.startMs - words[stop].endMs;
      if (next.endMs - words[start].startMs > 85_000 || gap > 2000 ||
        (words[stop].endMs - words[start].startMs >= 55_000 && gap >= 800)) break;
      stop++;
    }
    const first = words[start], last = words[stop];
    if (last.endMs - first.startMs >= MIN_CLIP_MS) {
      const startMs = Math.max(0, first.startMs - 300);
      const endMs = Math.min(durationMs, last.endMs + 500);
      if (endMs - startMs < MIN_CLIP_MS || endMs - startMs > MAX_CLIP_MS) { start = stop + 1; continue; }
      const opening = words.slice(start, Math.min(start + 10, stop + 1)).map((w) => w.text).join(" ");
      const pause = Math.max(0, start === 0 ? 0 : first.startMs - words[start - 1].endMs);
      const score = Math.min(95, 50 + Math.min(18, Math.round(pause / 90)) + (/[?!]/.test(opening) ? 8 : 0));
      windows.push({ title: opening.length > 58 ? `${opening.slice(0, 55).trimEnd()}…` : opening,
        startMs, endMs, score, rationale: "Transcript passage; check its opening and ending before publishing." });
    }
    start = Math.max(stop + 1, start + 1);
  }
  if (windows.length <= max) return windows;
  const chosen = new Set<number>();
  // Cover the whole source, then fill the remaining slots by the strongest pause/opening cues.
  const coverage = Math.min(Math.ceil(max / 2), windows.length);
  for (let index = 0; index < coverage; index++) {
    const from = Math.floor(index * windows.length / coverage);
    const to = Math.floor((index + 1) * windows.length / coverage);
    let best = from;
    for (let option = from + 1; option < to; option++) if (windows[option].score > windows[best].score) best = option;
    chosen.add(best);
  }
  for (const item of windows.map((window, index) => ({ window, index })).sort((a, b) => b.window.score - a.window.score)) {
    if (chosen.size >= max) break;
    chosen.add(item.index);
  }
  return [...chosen].sort((a, b) => a - b).map((index) => windows[index]);
}

export type Caption = z.infer<typeof caption>;
export function captionsForClip(words: Word[], startMs: number, endMs: number): Caption[] {
  return words.filter((word) => word.startMs >= startMs && word.endMs <= endMs)
    .map(({ text, startMs, endMs }) => ({ text, startMs, endMs }));
}
/** Add newly exposed speech without replacing text/timing corrections inside the old cut. */
export function captionsForExpandedCut(existing: Caption[], words: Word[], oldStart: number, oldEnd: number,
  startMs: number, endMs: number): Caption[] {
  const kept = existing.filter((item) => item.startMs >= startMs && item.endMs <= endMs);
  const added = captionsForClip(words, startMs, endMs).filter((item) =>
    (item.startMs < oldStart || item.endMs > oldEnd) &&
    !kept.some((saved) => saved.startMs === item.startMs && saved.endMs === item.endMs));
  return [...kept, ...added].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}
export function sourceMinutes(durationMs: number): number {
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0 || durationMs > MAX_DURATION_MS) throw new Error("Source duration outside supported range");
  return Math.ceil(durationMs / 60_000);
}
