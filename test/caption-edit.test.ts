import { expect, test } from "bun:test";
import { insertCaption, removeCaption } from "../src/domain/caption-edit.ts";
import { clipEdit } from "../src/domain/media.ts";

const base = { title: "Interview", startMs: 1000, endMs: 12_000, cropX: 500, cropY: 500, zoom: 1000, revision: 1 };
const captions = [{ text: "The", startMs: 1000, endMs: 1800 }, { text: "answer", startMs: 1500, endMs: 2200 },
  { text: "yes", startMs: 2200, endMs: 2600 }];
test("insert missing words at the beginning and between overlapping speakers, then remove hallucinated words", () => {
  const withStart = insertCaption(captions, -1, "Well", 1000, 12_000);
  const withOverlap = insertCaption(withStart, 1, "actually", 1000, 12_000);
  expect(withOverlap.map((word) => word.text)).toEqual(["Well", "The", "actually", "answer", "yes"]);
  expect(clipEdit.safeParse({ ...base, captions: withOverlap }).success).toBe(true);
  const corrected = removeCaption(withOverlap, 3);
  expect(corrected.map((word) => word.text)).toEqual(["Well", "The", "actually", "yes"]);
  expect(clipEdit.safeParse({ ...base, captions: corrected }).success).toBe(true);
  expect(() => insertCaption(corrected, 2, " ", 1000, 12_000)).toThrow();
});
