import { z } from "zod";

export const captionStyle = z.object({
  preset: z.enum(["classic", "bold", "minimal"]),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  size: z.number().int().min(48).max(110),
  position: z.enum(["low", "middle"]),
});
export type CaptionStyle = z.infer<typeof captionStyle>;
export const captionPresets: Record<CaptionStyle["preset"], CaptionStyle> = {
  classic: { preset: "classic", color: "#FFFFFF", size: 76, position: "low" },
  bold: { preset: "bold", color: "#FFE083", size: 92, position: "middle" },
  minimal: { preset: "minimal", color: "#FFFFFF", size: 62, position: "low" },
};
export const defaultCaptionStyle = captionPresets.classic;

/** ASS uses BGR byte order, unlike CSS RGB. */
export function assColor(hex: string): string {
  return `&H00${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}`.toUpperCase();
}
export function captionLayout(style: CaptionStyle) {
  const preset = style.preset;
  return { marginV: style.position === "low" ? 315 : 690,
    outline: preset === "minimal" ? 3 : preset === "bold" ? 6 : 5,
    shadow: preset === "minimal" ? 0 : 2,
    bold: preset === "minimal" ? 0 : -1 };
}
