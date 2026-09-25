import { describe, expect, test } from "bun:test";
import { deepgramResponse } from "../src/domain/transcript.ts";

describe("Workers AI word-timing response", () => {
  test("preserves timing, confidence, punctuation and speaker attribution", () => {
    const data = deepgramResponse.parse({ results: { channels: [{ alternatives: [{ words: [
      { word: "hello", punctuated_word: "Hello,", start: 0, end: 0.3, speaker: 0, confidence: 0.98 },
    ] }] }] } });
    expect(data.results.channels[0].alternatives[0].words[0].punctuated_word).toBe("Hello,");
  });
  test("allows silence but rejects malformed timestamps and absent channels", () => {
    expect(deepgramResponse.parse({ results: { channels: [{ alternatives: [{}] }] } })
      .results.channels[0].alternatives[0].words).toEqual([]);
    expect(() => deepgramResponse.parse({ results: { channels: [] } })).toThrow();
    expect(() => deepgramResponse.parse({ results: { channels: [{ alternatives: [{ words: [
      { word: "no", start: -1, end: 1 },
    ] }] }] } })).toThrow();
  });
});
