import { z } from "zod";

export const renderOptions = z.object({
  startMs: z.number().int().nonnegative(), endMs: z.number().int().positive(),
  cropX: z.number().int().min(0).max(1000), cropY: z.number().int().min(0).max(1000),
  zoom: z.number().int().min(1000).max(2500),
  captions: z.array(z.object({ text: z.string().min(1).max(80), startMs: z.number().int(), endMs: z.number().int() })).max(600),
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
  const groups: Array<typeof options.captions> = [];
  let group: typeof options.captions = [];
  for (const word of options.captions) {
    if (word.startMs < options.startMs || word.endMs > options.endMs || word.endMs <= word.startMs) continue;
    if (group.length >= 4 || (group.length > 0 && (word.startMs - group[0].startMs > 1600 || word.startMs - group[group.length - 1].endMs > 360))) {
      groups.push(group); group = [];
    }
    group.push(word);
  }
  if (group.length) groups.push(group);
  const events = groups.flatMap((words) => words.map((word, index) => {
    const next = words[index + 1];
    const start = word.startMs - options.startMs;
    const end = Math.min(options.endMs - options.startMs, Math.max(word.endMs, next ? next.startMs : word.endMs + 180) - options.startMs);
    const text = words.map((item, position) => `${position === index ? "{\\1c&H53DDFF&}" : "{\\1c&HFFFFFF&}"}${safeText(item.text)}`).join(" ");
    return `Dialogue: 0,${assTime(start)},${assTime(Math.max(start + 30, end))},Caption,,0,0,0,,${text}`;
  }));
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\nWrapStyle: 2\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Caption,DejaVu Sans,76,&H00FFFFFF,&H00FFFFFF,&H000B1020,&H880B1020,-1,0,0,0,100,100,0,0,1,5,2,2,65,65,315,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${events.join("\n")}\n`;
}

/** Crop fits 9:16 within the input before applying focal-point offset and zoom. */
export function cropFilter(width: number, height: number, cropX: number, cropY: number, zoom: number): string {
  const aspect = 9 / 16;
  const baseW = Math.min(width, height * aspect);
  const baseH = baseW / aspect;
  const cropW = Math.max(2, Math.floor(baseW * 1000 / zoom / 2) * 2);
  const cropH = Math.max(2, Math.floor(baseH * 1000 / zoom / 2) * 2);
  const left = Math.max(0, Math.min(width - cropW, Math.round((width - cropW) * cropX / 1000 / 2) * 2));
  const top = Math.max(0, Math.min(height - cropH, Math.round((height - cropH) * cropY / 1000 / 2) * 2));
  return `crop=${cropW}:${cropH}:${left}:${top},scale=1080:1920:flags=lanczos`;
}
