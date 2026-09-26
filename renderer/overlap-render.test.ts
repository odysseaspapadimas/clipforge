import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAss, renderOptions } from "./captions.ts";
import { captionFrames } from "./caption-timeline.ts";

const captions = [{ text: "ONE", startMs: 250, endMs: 1750 }, { text: "TWO", startMs: 1000, endMs: 1500 }];
test("concurrent speakers become a single bounded ASS event with two visible rendered lines", () => {
  const frames = captionFrames(captions, 0, 2000);
  expect(frames.map((frame) => [frame.startCs, frame.endCs, frame.words.length]))
    .toEqual([[25, 100, 1], [100, 150, 2], [150, 175, 1]]);
  const ass = buildAss(renderOptions.parse({ startMs: 0, endMs: 2000, cropX: 500, cropY: 500, zoom: 1000, captions }));
  const dialogues = ass.split("\n").filter((line) => line.startsWith("Dialogue:"));
  expect(dialogues).toHaveLength(3);
  expect(dialogues[1]).toContain("ONE\\NTWO");
  expect(dialogues[1]).toContain("0:00:01.00,0:00:01.50");
  const root = mkdtempSync(join(tmpdir(), "clipforge-overlap-"));
  try {
    const assPath = join(root, "captions.ass");
    writeFileSync(assPath, ass);
    const output = Bun.spawnSync(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=360x640:r=2:d=2",
      "-vf", `ass=${assPath}`, "-pix_fmt", "gray", "-f", "rawvideo", "pipe:1"], { maxBuffer: 8_000_000 });
    expect(output.exitCode).toBe(0);
    const frameSize = 360 * 640;
    expect(output.stdout.length).toBe(frameSize * 4);
    const count = (frameIndex: number, fromRow: number, toRow: number) => {
      let lit = 0;
      for (let row = fromRow; row < toRow; row++) for (let x = 0; x < 360; x++) {
        if (output.stdout[frameIndex * frameSize + row * 360 + x] > 120) lit++;
      }
      return lit;
    };
    // 0.5s: ONE, 1.0s: ONE + TWO. The extra line appears above the baseline.
    expect(count(1, 450, 630)).toBeGreaterThan(50);
    expect(count(2, 450, 630)).toBeGreaterThan(count(1, 450, 630) + 50);
    expect(count(2, 450, 545)).toBeGreaterThan(count(1, 450, 545) + 50);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
