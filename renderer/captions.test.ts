import { expect, test } from "bun:test";
import { buildAss, cropFilter, renderOptions } from "./captions.ts";
import { captionPresets } from "../src/domain/caption-style.ts";
import { cropRect, previewCropStyle } from "../src/domain/crop.ts";
import { displayDimensions } from "../src/domain/orientation.ts";

test("crop always fits portrait viewport and moves focal point", () => {
  expect(cropFilter(1920, 1080, 0, 500, 1000)).toStartWith("crop=606:1080:0:0");
  expect(cropFilter(1920, 1080, 1000, 500, 1000)).toContain(":1314:0,");
});
test("browser viewport represents precisely the FFmpeg crop, including rotation and 2x left focus", () => {
  const landscape = cropRect(1920, 1080, 0, 500, 2000);
  expect(landscape).toEqual({ width: 302, height: 540, left: 0, top: 270 });
  const preview = previewCropStyle(1920, 1080, 0, 500, 2000);
  expect(preview.left).toBe("0%");
  expect(preview.width).toBe(`${100 * 1920 / 302}%`);
  expect(cropFilter(1920, 1080, 0, 500, 2000)).toStartWith("crop=302:540:0:270,");
  const portrait = displayDimensions({ width: 640, height: 360, side_data_list: [{ rotation: -90 }] });
  expect(portrait).toEqual({ width: 360, height: 640 });
  expect(cropRect(portrait.width, portrait.height, 500, 500, 1000)).toEqual({ width: 360, height: 640, left: 0, top: 0 });
  expect(displayDimensions({ width: 640, height: 360, tags: { rotate: 90 } })).toEqual(portrait);
});
test("caption presets and custom colors/sizes/position survive into ASS without directives", () => {
  const base = { startMs: 0, endMs: 9000, cropX: 500, cropY: 500, zoom: 1000, captions: [] };
  for (const preset of Object.values(captionPresets)) {
    const ass = buildAss(renderOptions.parse({ ...base, captionStyle: preset }));
    expect(ass).toContain(`DejaVu Sans,${preset.size},`);
  }
  const customized = buildAss(renderOptions.parse({ ...base, captionStyle: { ...captionPresets.bold, color: "#12A4F0", size: 105, position: "low" } }));
  expect(customized).toContain("DejaVu Sans,105,&H00F0A412");
  expect(customized).toContain(",65,65,315,1");
  expect(renderOptions.safeParse({ ...base, captionStyle: { ...captionPresets.bold, color: "#fff}\\nDialogue: evil" } }).success).toBe(false);
  expect(renderOptions.safeParse({ ...base, captionStyle: { ...captionPresets.bold, size: 900 } }).success).toBe(false);
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
