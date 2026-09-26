import { describe, expect, test } from "bun:test";
import { captionsForClip, captionsForExpandedCut, clipEdit, discoverCandidates, normalizeWords, sourceMinutes, uploadInput, type Word } from "../src/domain/media";

const words: Word[] = Array.from({ length: 120 }, (_, index) => ({
  text: index % 12 === 0 ? "Why" : `word${index}`,
  startMs: index * 800, endMs: index * 800 + 500, speaker: index < 60 ? 0 : 1, confidence: 0.97,
}));
describe("media boundaries", () => {
  test("metering rounds source durations up only once", () => {
    expect(sourceMinutes(60_001)).toBe(2);
    expect(() => sourceMinutes(0)).toThrow();
    expect(() => sourceMinutes(7_200_001)).toThrow();
  });
  test("enforces tenant-facing upload and editor bounds", () => {
    expect(uploadInput.safeParse({ name: "show.mp4", size: 1000, mimeType: "video/mp4" }).success).toBe(true);
    expect(uploadInput.safeParse({ name: "show.mp4", size: 5 * 1024 ** 3, mimeType: "video/mp4" }).success).toBe(true);
    expect(uploadInput.safeParse({ name: "unpreviewable.mov", size: 1000, mimeType: "video/quicktime" }).success).toBe(false);
    expect(uploadInput.safeParse({ name: "bad", size: 5_368_709_120, mimeType: "application/octet-stream" }).success).toBe(false);
    expect(clipEdit.safeParse({ title: "Interview", startMs: 1000, endMs: 20_000, cropX: 500, cropY: 500,
      zoom: 1000, captions: [{ text: "hello", startMs: 1000, endMs: 1400 }], revision: 1 }).success).toBe(true);
    expect(clipEdit.safeParse({ title: "Interview", startMs: 1000, endMs: 20_000, cropX: 500, cropY: 500,
      zoom: 1000, captions: [{ text: "hello", startMs: 900, endMs: 1400 }], revision: 1 }).success).toBe(false);
  });
  test("never bridges a distant next word into an unexportable candidate", () => {
    const short = words.slice(0, 12).map((word, index) => ({ ...word, startMs: index * 450, endMs: index * 450 + 350 }));
    const jumped = { ...words[12], startMs: 241_000, endMs: 241_250 };
    expect(discoverCandidates([...short, jumped], 250_000)).toEqual([]);
    const long = [...words.slice(0, 100), jumped];
    expect(discoverCandidates(long, 250_000).every((item) => item.endMs - item.startMs <= 180_000 && item.endMs < 241_000)).toBe(true);
  });
  test("retains overlapping speakers and merges expanded cuts without overwriting edits", () => {
    const overlap = normalizeWords([{ text: "Long", startMs: 0, endMs: 1000, speaker: 0, confidence: 1 },
      { text: "Yes!", startMs: 200, endMs: 400, speaker: 1, confidence: 1 }], 2000);
    expect(overlap.map((word) => word.text)).toEqual(["Long", "Yes!"]);
    expect(captionsForClip(overlap, 0, 2000)).toHaveLength(2);
    const expanded = captionsForExpandedCut([{ text: "edited", startMs: 1000, endMs: 1200 }], [
      { text: "before", startMs: 500, endMs: 700, speaker: 0, confidence: null },
      { text: "original", startMs: 1000, endMs: 1200, speaker: 0, confidence: null },
      { text: "after", startMs: 2000, endMs: 2200, speaker: 0, confidence: null },
    ], 800, 1800, 0, 2500);
    expect(expanded.map((item) => item.text)).toEqual(["before", "edited", "after"]);
  });
  test("suggests bounded transcript clips and retains word timing", () => {
    const normalized = normalizeWords(words, 100_000);
    const suggestions = discoverCandidates(normalized, 100_000);
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.every((s) => s.endMs - s.startMs <= 180_000)).toBe(true);
    expect(captionsForClip(normalized, suggestions[0].startMs, suggestions[0].endMs).length).toBeGreaterThan(0);
  });
});
