import { expect, test } from "bun:test";
import { buildAss, cropFilter, renderOptions } from "./captions.ts";

test("crop always fits portrait viewport and moves focal point", () => {
  expect(cropFilter(1920, 1080, 0, 500, 1000)).toStartWith("crop=606:1080:0:0");
  expect(cropFilter(1920, 1080, 1000, 500, 1000)).toContain(":1314:0,");
});
test("caption text cannot inject subtitle directives and stays relative to the clip", () => {
  const options = renderOptions.parse({ startMs: 10_000, endMs: 30_000, cropX: 500, cropY: 500, zoom: 1000,
    captions: [{ text: "Hi{\\pos(0,0)}", startMs: 10_000, endMs: 10_500 },
      { text: "there", startMs: 10_510, endMs: 10_900 }] });
  const output = buildAss(options);
  expect(output).not.toContain("{\\pos");
  expect(output).toContain("Dialogue: 0,0:00:00.00");
  expect(output).toContain("Hi(∖pos(0,0))");
});
