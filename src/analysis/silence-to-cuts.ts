import { SilenceReport } from "../core/schemas.js";
import type { z } from "zod";

export interface SilenceToCutsParams {
  /** gaps shorter than this are left alone (editorial default: 0.5s) */
  minDuration: number;
  /** seconds of silence kept on each side of a removed gap (default 0.25) */
  pad: number;
}

const MIN_CUT = 0.01;

/**
 * Expand silence observations into explicit plan cut operations.
 * Pure and deterministic — the editorial decisions are the parameters
 * (which gaps qualify, how much breathing room to keep).
 */
export function silenceToCuts(
  report: z.infer<typeof SilenceReport>,
  sourceDuration: number,
  params: SilenceToCutsParams,
): { type: "cut"; start: number; end: number }[] {
  const cuts: { type: "cut"; start: number; end: number }[] = [];
  for (const seg of report.segments) {
    if (seg.duration < params.minDuration) continue;
    const start = Math.max(0, seg.start + params.pad);
    const end = Math.min(sourceDuration, seg.end - params.pad);
    if (end - start < MIN_CUT) continue;
    cuts.push({ type: "cut", start: round3(start), end: round3(end) });
  }
  return cuts;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
