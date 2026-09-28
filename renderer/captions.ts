import { z } from "zod";
import { cropRect } from "./crop.ts";
import { captionFrames, captionLines } from "./caption-timeline.ts";
import { assColor, captionLayout, captionStyle, defaultCaptionStyle } from "./caption-style.ts";

export const renderOptions = z.object({
  startMs: z.number().int().nonnegative(), endMs: z.number().int().positive(),
  cropX: z.number().int().min(0).max(1000), cropY: z.number().int().min(0).max(1000),
  zoom: z.number().int().min(1000).max(2500),
  captions: z.array(z.object({ text: z.string().min(1).max(80), startMs: z.number().int(), endMs: z.number().int() })).max(600),
  captionStyle: captionStyle.default(defaultCaptionStyle),
}).refine((value) => value.endMs > value.startMs && value.endMs - value.startMs <= 180_000);
export type RenderOptions = z.infer<typeof renderOptions>;

function assTime(ms: number): string {
  const centiseconds = Math.max(0, Math.round(ms / 10));
  const hours = Math.floor(centiseconds / 360000);
  const minutes = Math.floor((centiseconds % 360000) / 6000);
  const seconds = Math.floor((centiseconds % 6000) / 100);
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(centiseconds % 100).padStart(2, "0")}`;
}
function safeText(text: string): string {
  return text.replaceAll("\\", "∖").replaceAll("{", "(").replaceAll("}", ")")
    .replaceAll(/[\r\n\t]/g, " ").slice(0, 80);
}

/** Karaoke-style word highlights; all times are relative to the selected source boundary. */
export function buildAss(options: RenderOptions): string {
  const events = captionFrames(options.captions, options.startMs, options.endMs).map((frame) => {
    const text = captionLines(frame.words).map((line) => safeText(line)).join("\\N");
    return `Dialogue: 0,${assTime(frame.startCs * 10)},${assTime(frame.endCs * 10)},Caption,,0,0,0,,${text}`;
  });
  const style = captionStyle.parse(options.captionStyle);
  const layout = captionLayout(style);
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\nWrapStyle: 2\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Caption,DejaVu Sans,${style.size},${assColor(style.color)},${assColor(style.color)},&H000B1020,&H880B1020,${layout.bold},0,0,0,100,100,0,0,1,${layout.outline},${layout.shadow},2,65,65,${layout.marginV},1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${events.join("\n")}\n`;
}

/** Crop fits 9:16 within the input before applying focal-point offset and zoom. */
export function cropFilter(width: number, height: number, cropX: number, cropY: number, zoom: number): string {
  const rect = cropRect(width, height, cropX, cropY, zoom);
  return `crop=${rect.width}:${rect.height}:${rect.left}:${rect.top},scale=1080:1920:flags=lanczos`;
}
