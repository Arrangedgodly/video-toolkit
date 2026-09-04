import { HighlightReport } from "../core/schemas.js";
import type { z } from "zod";

export interface HighlightsToTrimsParams {
  /** at most this many candidates become trims (editorial default: 5) */
  count: number;
  /** candidates scoring below this are ignored (editorial default: 0.35) */
  minScore: number;
  /** seconds of breathing room added to each side (default 0.5) */
  pad: number;
}

const MIN_TRIM = 0.01;

/**
 * Expand highlight proposals into explicit plan trim operations: a
 * compilation that keeps the top candidates by score (ties break toward the
 * earlier start). Pure and deterministic — the editorial decisions are the
 * parameters (how many, how good, how much breathing room). Overlapping
 * ranges pass through untouched: trims already union in the timeline
 * compiler, so no merge semantics live here. The agent decides — this
 * only proposes.
 */
export function highlightsToTrims(
  report: z.infer<typeof HighlightReport>,
  sourceDuration: number,
  params: HighlightsToTrimsParams,
): { type: "trim"; start: number; end: number }[] {
  return report.candidates
    .filter((c) => c.score >= params.minScore)
    .sort((a, b) => b.score - a.score || a.start - b.start)
    .slice(0, Math.max(0, params.count))
    .sort((a, b) => a.start - b.start)
    .flatMap((c) => {
      const start = Math.max(0, c.start - params.pad);
      const end = Math.min(sourceDuration, c.end + params.pad);
      if (end - start < MIN_TRIM) return []; // fully consumed by clamping
      return [{ type: "trim" as const, start: round3(start), end: round3(end) }];
    });
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
