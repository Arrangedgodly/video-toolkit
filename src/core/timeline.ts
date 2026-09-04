import { fail } from "./errors.js";
import type { Operation } from "./schemas.js";

/** A contiguous keep-range on the source timeline, in seconds. */
export interface Segment {
  start: number;
  end: number;
}

const MIN_SEGMENT = 0.01;
const TOUCH_EPSILON = 0.001;

function normalize(ranges: Segment[]): Segment[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: Segment[] = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last && r.start - last.end < TOUCH_EPSILON) {
      last.end = Math.max(last.end, r.end);
    } else {
      merged.push({ ...r });
    }
  }
  return merged.filter((s) => s.end - s.start >= MIN_SEGMENT);
}

function subtract(segments: Segment[], range: Segment): Segment[] {
  const out: Segment[] = [];
  for (const s of segments) {
    if (range.end <= s.start || range.start >= s.end) {
      out.push(s);
      continue;
    }
    if (range.start > s.start) out.push({ start: s.start, end: range.start });
    if (range.end < s.end) out.push({ start: range.end, end: s.end });
  }
  return out.filter((s) => s.end - s.start >= MIN_SEGMENT);
}

/** Compile plan operations into the final list of keep-segments.
 *
 * Semantics: with no trims the whole source is kept; trims replace that with
 * their union; cuts subtract from the result. Order of operations does not
 * change the outcome — a plan is a declaration of what to keep, not a script.
 */
export function compileTimeline(
  operations: Operation[],
  sourceDuration: number,
): Segment[] {
  const trims = operations
    .filter((op): op is Extract<Operation, { type: "trim" }> => op.type === "trim")
    .map((op) => ({ start: op.start, end: op.end }));
  const cuts = operations
    .filter((op): op is Extract<Operation, { type: "cut" }> => op.type === "cut")
    .map((op) => ({ start: op.start, end: op.end }));

  let segments = normalize(trims.length > 0 ? trims : [{ start: 0, end: sourceDuration }]);
  for (const cut of cuts) {
    segments = subtract(segments, cut);
  }
  if (segments.length === 0) {
    fail("EMPTY_TIMELINE", "the operations remove every part of the source");
  }
  return segments;
}

export function totalDuration(segments: Segment[]): number {
  return segments.reduce((acc, s) => acc + (s.end - s.start), 0);
}

/** xfade offsets for the single-pass transition chain (R3, measured
 * frame-exact): O_k = (Σ_{i≤k} L_i) − k·D for k = 1..N−1. Each O_k is BOTH
 * the k-th xfade `offset` and the output-timeline boundary where segment
 * k+1's content begins; the fade occupies [O_k, O_k + D]. Offsets live in
 * the UNSCALED timeline — speed composes after the chain, so no
 * speed-aware offset math anywhere. */
export function xfadeOffsets(segments: Segment[], fadeSeconds: number): number[] {
  const offsets: number[] = [];
  let acc = 0;
  for (let k = 0; k + 1 < segments.length; k++) {
    acc += segments[k]!.end - segments[k]!.start;
    offsets.push(acc - (k + 1) * fadeSeconds);
  }
  return offsets;
}

/** THE canonical duration law of the transition path (R3): expected output =
 * compiled timeline − (N−1)·fade. Render progress/verify, validate's
 * expectation, and the mix bed trim all consume this one formula. D=0 or a
 * single segment degrade to the plain timeline total. */
export function adjustedDuration(segments: Segment[], fadeSeconds: number): number {
  const joins = Math.max(0, segments.length - 1);
  return Math.max(0, totalDuration(segments) - joins * Math.max(0, fadeSeconds));
}

/** ffmpeg select expression keeping exactly these segments (proven recipe,
 * ported from vedit: select + setpts=N/FRAME_RATE/TB regenerates CFR time). */
export function selectExpression(segments: Segment[]): string {
  return segments
    .map((s) => `between(t,${s.start.toFixed(3)},${s.end.toFixed(3)})`)
    .join("+");
}
