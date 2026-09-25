import { z } from "zod";

/** Workers AI @cf/deepgram/nova-3 returns Deepgram-compatible word timings. */
export const deepgramResponse = z.object({
  results: z.object({ channels: z.array(z.object({ alternatives: z.array(z.object({
    words: z.array(z.object({ word: z.string().min(1), punctuated_word: z.string().optional(),
      start: z.number().nonnegative(), end: z.number().positive(),
      confidence: z.number().min(0).max(1).optional(), speaker: z.number().int().nonnegative().optional() })).default([]),
  })).min(1) })).min(1) }),
});
