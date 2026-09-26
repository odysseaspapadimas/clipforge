import type { Caption } from "./media.ts";

/** Place a missing word after a selected caption (or at the beginning) while preserving ordered timing. */
export function insertCaption(captions: Caption[], after: number, text: string, clipStart: number, clipEnd: number): Caption[] {
  const value = text.trim();
  if (!value || value.length > 80 || after < -1 || after >= captions.length || clipEnd - clipStart < 2 || captions.length >= 600) {
    throw new Error("Enter a word of up to 80 characters within this clip");
  }
  const previous = captions[after];
  const next = captions[after + 1];
  // When speech overlaps, insert after the previous *start* (not its end) so a
  // long first speaker cannot reorder a shorter interjection by a second speaker.
  const lower = previous ? Math.max(clipStart, previous.startMs) : clipStart;
  const upper = next ? Math.min(clipEnd - 1, next.startMs) : clipEnd - 1;
  const startMs = Math.min(upper, Math.max(lower, previous ? previous.endMs : clipStart));
  const endMs = Math.min(clipEnd, Math.max(startMs + 1, Math.min(startMs + 350, next?.endMs ?? clipEnd)));
  const inserted = { text: value, startMs, endMs };
  return [...captions.slice(0, after + 1), inserted, ...captions.slice(after + 1)];
}

export function removeCaption(captions: Caption[], index: number): Caption[] {
  if (index < 0 || index >= captions.length) throw new Error("Caption not found");
  return captions.filter((_, position) => position !== index);
}
