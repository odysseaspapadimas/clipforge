import { describe, expect, test } from "bun:test";
import { captionsForClip, clipEdit, discoverCandidates, normalizeWords, sourceMinutes, uploadInput, type Word } from "../src/domain/media";

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
    expect(uploadInput.safeParse({ name: "bad", size: 5_368_709_120, mimeType: "application/octet-stream" }).success).toBe(false);
    expect(clipEdit.safeParse({ title: "Interview", startMs: 1000, endMs: 20_000, cropX: 500, cropY: 500,
      zoom: 1000, captions: [{ text: "hello", startMs: 1000, endMs: 1400 }], revision: 1 }).success).toBe(true);
    expect(clipEdit.safeParse({ title: "Interview", startMs: 1000, endMs: 20_000, cropX: 500, cropY: 500,
      zoom: 1000, captions: [{ text: "hello", startMs: 900, endMs: 1400 }], revision: 1 }).success).toBe(false);
  });
  test("suggests bounded transcript clips and retains word timing", () => {
    const normalized = normalizeWords(words, 100_000);
    const suggestions = discoverCandidates(normalized, 100_000);
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.every((s) => s.endMs - s.startMs <= 180_000)).toBe(true);
    expect(captionsForClip(normalized, suggestions[0].startMs, suggestions[0].endMs).length).toBeGreaterThan(0);
  });
});
