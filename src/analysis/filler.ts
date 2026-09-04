import { FillerReport, TranscriptReport, WordTiming } from "../core/schemas.js";
import { round3 } from "./runner.js";
import type { z } from "zod";

export type FillerReportData = z.infer<typeof FillerReport>;
export type FillerPrecision = "words" | "segments";

export interface FillerDetection {
  instances: z.infer<typeof FillerReport>["instances"];
  precision: FillerPrecision;
}

/** Editorial defaults; override with --words. Single words and short phrases. */
export const DEFAULT_FILLER_PHRASES = [
  "um", "uh", "umm", "uhh", "er", "ah",
  "like", "basically", "actually", "literally", "honestly", "seriously",
  "you know", "i mean", "sort of", "kind of",
];

function normalize(token: string): string {
  return token.toLowerCase().replace(/[^a-z']/g, "");
}

function normalizedPhraseList(phrases: string[]): string[][] {
  return phrases
    .map((p) => p.toLowerCase().trim().split(/\s+/).map(normalize).filter(Boolean))
    .filter((p) => p.length > 0)
    .sort((a, b) => b.length - a.length);
}

/** Exact path: match over consecutive words, anchor first-word start →
 * last-word end. Word text is normalized with the same rule as segment text
 * (case, punctuation, leading spaces — whisper-cpp word texts are trimmed
 * by the parser, but the rule is defensive). */
function detectInWords(
  words: z.infer<typeof WordTiming>[],
  normalizedPhrases: string[][],
  instances: z.infer<typeof FillerReport>["instances"],
): void {
  const norm = words.map((w) => normalize(w.text));
  for (let i = 0; i < words.length; i++) {
    if (!norm[i]) continue;
    let matched: string[] | null = null;
    for (const phrase of normalizedPhrases) {
      if (phrase.every((w, k) => norm[i + k] === w)) {
        matched = phrase;
        break; // longest phrase wins at this position
      }
    }
    if (!matched) continue;
    const first = words[i]!;
    const last = words[i + matched.length - 1]!;
    const ctxFrom = Math.max(0, i - 3);
    const ctxTo = Math.min(words.length, i + matched.length + 3);
    instances.push({
      start: round3(first.start),
      end: round3(last.end),
      phrase: matched.join(" "),
      context: words.slice(ctxFrom, ctxTo).map((w) => w.text).join(" "),
    });
    i += matched.length - 1; // consume matched words — no overlapping matches
  }
}

/** Estimate path (pre-T11 behavior, byte-identical): linear interpolation of
 * token position within the segment — chunked/windowed transcripts carry no
 * word timestamps, so treat times as approximate (± the segment granularity). */
function detectByInterpolation(
  seg: z.infer<typeof TranscriptReport>["segments"][number],
  normalizedPhrases: string[][],
  instances: z.infer<typeof FillerReport>["instances"],
): void {
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

/**
 * Detect filler-word candidates in a transcript. Segments carrying `words`
 * (whisper-cpp `--word-timestamps`) match over consecutive words and anchor
 * exact times (first-word start → last-word end); wordless segments keep the
 * linear-interpolation estimate. Phrases never match across segment
 * boundaries (matching is per-segment on both paths). `precision` is
 * "words" only when EVERY segment carried word timings — one wordless
 * segment and the report-level claim drops to "segments" (the weakest bound
 * governs; those segments are still matched, over their own words).
 * Deterministic given (transcript, phrases).
 */
export function detectFillerInstances(
  transcript: z.infer<typeof TranscriptReport>,
  phrases: string[] = DEFAULT_FILLER_PHRASES,
): FillerDetection {
  const normalizedPhrases = normalizedPhraseList(phrases);
  const instances: z.infer<typeof FillerReport>["instances"] = [];
  let allWordTimed = transcript.segments.length > 0;

  for (const seg of transcript.segments) {
    if (seg.words && seg.words.length > 0) {
      detectInWords(seg.words, normalizedPhrases, instances);
    } else {
      allWordTimed = false;
      detectByInterpolation(seg, normalizedPhrases, instances);
    }
  }

  return {
    instances: instances.sort((a, b) => a.start - b.start),
    precision: allWordTimed ? "words" : "segments",
  };
}
