export type TimedCaption = { text: string; startMs: number; endMs: number };
export type CaptionFrame = { startCs: number; endCs: number; words: TimedCaption[] };

/** Quantize to ASS centiseconds before building a single non-overlapping event per interval. */
export function captionFrames(captions: TimedCaption[], clipStart: number, clipEnd: number): CaptionFrame[] {
  const durationCs = Math.max(0, Math.round((clipEnd - clipStart) / 10));
  const items = captions.flatMap((word, index) => {
    if (word.startMs < clipStart || word.endMs > clipEnd || word.endMs <= word.startMs) return [];
    const startCs = Math.max(0, Math.round((word.startMs - clipStart) / 10));
    const endCs = Math.min(durationCs, Math.max(startCs + 1, Math.round((word.endMs - clipStart) / 10)));
    return endCs > startCs ? [{ word, index, startCs, endCs }] : [];
  });
  const boundaries = [...new Set(items.flatMap((item) => [item.startCs, item.endCs]))].sort((a, b) => a - b);
  const frames: CaptionFrame[] = [];
  for (let i = 0; i + 1 < boundaries.length; i++) {
    const startCs = boundaries[i], endCs = boundaries[i + 1];
    const words = items.filter((item) => item.startCs <= startCs && item.endCs >= endCs)
      .sort((a, b) => a.startCs - b.startCs || a.index - b.index).map((item) => item.word);
    if (words.length) frames.push({ startCs, endCs, words });
  }
  return frames;
}

/** At most four word-lines; explicitly mark pathological (>4) crosstalk instead of hiding it. */
export function captionLines(words: TimedCaption[]): string[] {
  const visible = words.slice(0, 3).map((word) => word.text);
  if (words.length > 3) visible.push(`+${words.length - 3} overlapping words`);
  return visible;
}
