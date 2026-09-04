import { FillerReport, TranscriptReport } from "../core/schemas.js";
import { round3 } from "./runner.js";
import type { z } from "zod";

export type FillerReportData = z.infer<typeof FillerReport>;

/** Editorial defaults; override with --words. Single words and short phrases. */
export const DEFAULT_FILLER_PHRASES = [
  "um", "uh", "umm", "uhh", "er", "ah",
  "like", "basically", "actually", "literally", "honestly", "seriously",
  "you know", "i mean", "sort of", "kind of",
];

function normalize(token: string): string {
  return token.toLowerCase().replace(/[^a-z']/g, "");
}

/**
 * Detect filler-word candidates in a transcript. Times are estimated by
 * linear interpolation of token position within each segment — chunked
 * transcripts carry no word timestamps, so treat times as approximate
 * (± the segment granularity). Deterministic given (transcript, phrases).
 */
export function detectFillerInstances(
  transcript: z.infer<typeof TranscriptReport>,
  phrases: string[] = DEFAULT_FILLER_PHRASES,
): z.infer<typeof FillerReport>["instances"] {
  const normalizedPhrases = phrases
    .map((p) => p.toLowerCase().trim().split(/\s+/).map(normalize).filter(Boolean))
    .filter((p) => p.length > 0)
    .sort((a, b) => b.length - a.length);

  const instances: z.infer<typeof FillerReport>["instances"] = [];

  for (const seg of transcript.segments) {
    const rawWords = seg.text.trim().split(/\s+/);
    const norm = rawWords.map(normalize);
    const n = Math.max(1, norm.length);
    const span = seg.end - seg.start;

    for (let i = 0; i < n; i++) {
      if (!norm[i]) continue;
      let matched: string[] | null = null;
      for (const phrase of normalizedPhrases) {
        if (phrase.every((w, k) => norm[i + k] === w)) {
          matched = phrase;
          break; // longest phrase wins at this position
        }
      }
      if (!matched) continue;
      const start = seg.start + (span * i) / n;
      const end = seg.start + (span * (i + matched.length)) / n;
      const ctxFrom = Math.max(0, i - 3);
      const ctxTo = Math.min(rawWords.length, i + matched.length + 3);
      instances.push({
        start: round3(start),
        end: round3(end),
        phrase: matched.join(" "),
        context: rawWords.slice(ctxFrom, ctxTo).join(" "),
      });
      i += matched.length - 1; // consume matched tokens — no overlapping matches
    }
  }

  return instances.sort((a, b) => a.start - b.start);
}
