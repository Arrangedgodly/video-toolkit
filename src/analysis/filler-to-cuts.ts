import { FillerReport } from "../core/schemas.js";
import type { z } from "zod";

export interface FillerToCutsParams {
  /** seconds cut before the estimated filler start (editorial default: 0.1) */
  padBefore: number;
  /** seconds cut after the estimated filler end (editorial default: 0.25) */
  padEnd: number;
}

const MIN_CUT = 0.01;

/**
 * Expand filler observations into explicit plan cut operations. Filler times
 * are linear estimates within segment granularity, so the pads EXPAND the cut
 * beyond the estimate (the default asymmetry keeps the leading breath small
 * and covers the drawn-out tail). Pure and deterministic — the editorial
 * decisions are the parameters. The agent judges which instances are dead
 * air and verifies estimates with extract-frame before rendering.
 */
export function fillerToCuts(
  report: z.infer<typeof FillerReport>,
  sourceDuration: number,
  params: FillerToCutsParams,
): { type: "cut"; start: number; end: number }[] {
  const cuts: { type: "cut"; start: number; end: number }[] = [];
  for (const inst of report.instances) {
    const start = Math.max(0, inst.start - params.padBefore);
    const end = Math.min(sourceDuration, inst.end + params.padEnd);
    if (end - start < MIN_CUT) continue;
    cuts.push({ type: "cut", start: round3(start), end: round3(end) });
  }
  return cuts;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
