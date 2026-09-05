import { normalize, subtract, type Segment } from "../core/timeline.js";
import type { CacheOpts } from "../cache/cache.js";
import type { Operation } from "../core/schemas.js";
import { validatePlan, type ValidationReport } from "./validate.js";

/** Advisory plan lint (T24) — a deterministic judgment layer between
 * validate and preview: validate says whether a plan is VALID; lint says
 * whether it is CLEAN. Bridges and agents accumulate redundant/mergeable ops
 * across W1 iterations; lint names them. Workers propose, agents decide —
 * suggestions are never auto-applied, `fix` is advisory text, and lint NEVER
 * mutates the plan and NEVER changes validate's verdict (exit 0 always on a
 * valid plan; an invalid plan is a validate concern — the EXISTING
 * ValidationReport comes back with its own codes and the caller exits 1).
 * Pure rule engine: plan JSON + the probed source duration are the only
 * inputs — no cache, no wall-clock, no randomness (byte-identical output for
 * the same plan). */

/** The seven rule codes (alphabetical = the report's secondary sort key).
 * SUGGEST_PREVIEW is OMITTED by recorded decision (plan.md T24): whether a
 * preview has been rendered is unknowable from plan JSON + the probed
 * duration — not implemented, not a silent skip. */
export const LINT_CODES = [
  "MERGEABLE_TRIMS",
  "NOOP_CUT",
  "NOOP_VOLUME",
  "OVERLAPPING_CUTS",
  "REDUNDANT_CUT",
  "REDUNDANT_TRIM",
  "SUBSECOND_SEGMENT",
] as const;

export type LintCode = (typeof LINT_CODES)[number];

/** One advisory finding. `operation` is the 1-based DECLARED index
 * (validate's convention); absent when the finding is compiled-segment
 * anchored (SUBSECOND_SEGMENT). */
export interface Suggestion {
  code: LintCode;
  operation?: number;
  message: string;
  fix?: string;
}

export interface LintReport {
  suggestions: Suggestion[];
}

// Editorial thresholds (plan.md T24 — recorded constants; agents may
// disagree with a suggestion, never be blocked by one).

/** two trims separated by a gap ≤ this are one continuous keep expressed as
 * two ops (the compiler auto-merges < 0.001 s = TOUCH_EPSILON silently; the
 * rule names the pair across the whole band either way) */
export const MERGEABLE_TRIM_GAP = 0.01;
/** a cut removing less kept time than this (timeline MIN_SEGMENT) changes
 * nothing observable — includes start/end equal at 3 decimals */
export const MIN_CUT_EFFECT = 0.01;
/** compiled keep-segments shorter than this are likely bridge/editing
 * mistakes */
export const SUBSECOND_SEGMENT_MIN = 0.5;

// ---- shared pure helpers

const fmt = (r: Segment) => `[${r.start.toFixed(3)}, ${r.end.toFixed(3)}]`;

const overlapLen = (a: Segment, b: Segment): number =>
  Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));

interface NumberedRange {
  /** 1-based declared operation index */
  n: number;
  range: Segment;
}

function numberedRanges(ops: Operation[], type: "trim" | "cut"): NumberedRange[] {
  const out: NumberedRange[] = [];
  ops.forEach((op, i) => {
    if (op.type === type) out.push({ n: i + 1, range: { start: op.start, end: op.end } });
  });
  return out;
}

/** The compiler's cut walk, per step: the kept segments BEFORE each cut, the
 * kept time that cut actually removes (its intersection with the state), and
 * the final compiled segments. Mirrors compileTimeline call-for-call (same
 * normalize + subtract in the same order) minus the EMPTY_TIMELINE throw —
 * lint only ever runs on a valid plan, and a pure trace on an emptying plan
 * simply ends at []. This incremental state is what lets REDUNDANT_CUT flag
 * only the SECOND of two covering cuts (the first did real work). */
function cutTrace(
  ops: Operation[],
  sourceDuration: number,
): { steps: { n: number; range: Segment; removes: number }[]; final: Segment[] } {
  const trims = numberedRanges(ops, "trim").map((t) => t.range);
  let segments = normalize(trims.length > 0 ? trims : [{ start: 0, end: sourceDuration }]);
  const steps: { n: number; range: Segment; removes: number }[] = [];
  for (const { n, range } of numberedRanges(ops, "cut")) {
    const removes = segments.reduce((acc, s) => acc + overlapLen(s, range), 0);
    steps.push({ n, range, removes });
    segments = subtract(segments, range);
  }
  return { steps, final: segments };
}

// ---- the seven rules (pure, individually exported, individually tested)

/** REDUNDANT_TRIM — a trim fully contained in the union of EARLIER trims;
 * declared order names the redundant one deterministically. Containment
 * follows the compiler's own semantics (TOUCH_EPSILON gap-merge, sub
 * MIN_SEGMENT residual drop): a flagged trim contributes no compiled keep
 * time. */
export function redundantTrims(ops: Operation[]): Suggestion[] {
  const trims = numberedRanges(ops, "trim");
  const out: Suggestion[] = [];
  for (let j = 1; j < trims.length; j++) {
    const candidate = trims[j]!;
    const earlierMerged = normalize(trims.slice(0, j).map((t) => t.range));
    let residual: Segment[] = [candidate.range];
    for (const e of earlierMerged) residual = subtract(residual, e);
    if (residual.length > 0) continue;
    const covering = trims
      .slice(0, j)
      .filter((t) => overlapLen(t.range, candidate.range) > 0)
      .map((t) => t.n);
    out.push({
      code: "REDUNDANT_TRIM",
      operation: candidate.n,
      message:
        `trim ${fmt(candidate.range)} adds no kept time: fully contained in the union of ` +
        `earlier trims${covering.length > 0 ? ` (operation${covering.length > 1 ? "s" : ""} ${covering.join(", ")})` : ""}`,
      fix: `remove operation ${candidate.n}`,
    });
  }
  return out;
}

/** REDUNDANT_CUT — a cut whose range is already fully removed: kept-time
 * intersection 0, evaluated against the incrementally SUBTRACTED segments so
 * only the first of two covering cuts does work (the rest are flagged). */
export function redundantCuts(ops: Operation[], sourceDuration: number): Suggestion[] {
  const { steps } = cutTrace(ops, sourceDuration);
  const out: Suggestion[] = [];
  for (const step of steps) {
    if (step.removes > 0) continue;
    const earlier = steps.filter((s) => s.n < step.n && overlapLen(s.range, step.range) > 0);
    out.push({
      code: "REDUNDANT_CUT",
      operation: step.n,
      message:
        earlier.length > 0
          ? `cut ${fmt(step.range)} removes nothing: operation${earlier.length > 1 ? "s" : ""} ` +
            `${earlier.map((s) => s.n).join(", ")} already removed the range`
          : `cut ${fmt(step.range)} removes nothing: no kept time falls inside the range ` +
            `(earlier operations removed it, or the trims never kept it)`,
      fix: `remove operation ${step.n}`,
    });
  }
  return out;
}

/** MERGEABLE_TRIMS — two trims separated by a gap ≤ 0.01 s (down to and
 * including touching, gap 0); overlapping trims already union and are NOT
 * this rule's concern. The pair is named; the LATER declared op anchors the
 * suggestion. */
export function mergeableTrims(ops: Operation[]): Suggestion[] {
  const trims = numberedRanges(ops, "trim");
  const out: Suggestion[] = [];
  for (let i = 0; i < trims.length; i++) {
    for (let j = i + 1; j < trims.length; j++) {
      const a = trims[i]!;
      const b = trims[j]!;
      if (overlapLen(a.range, b.range) > 0) continue;
      const gap =
        b.range.start >= a.range.end ? b.range.start - a.range.end : a.range.start - b.range.end;
      if (gap > MERGEABLE_TRIM_GAP) continue;
      const merged = {
        start: Math.min(a.range.start, b.range.start),
        end: Math.max(a.range.end, b.range.end),
      };
      out.push({
        code: "MERGEABLE_TRIMS",
        operation: b.n,
        message:
          `trims ${fmt(a.range)} (operation ${a.n}) and ${fmt(b.range)} (operation ${b.n}) ` +
          `are separated by a ${gap.toFixed(3)}s gap — one continuous keep expressed as two ops`,
        fix: `replace operations ${a.n} and ${b.n} with one trim ${fmt(merged)}`,
      });
    }
  }
  return out;
}

/** NOOP_VOLUME — `db: 0` or `factor: 1`: parses, does nothing. */
export function noopVolume(ops: Operation[]): Suggestion[] {
  const out: Suggestion[] = [];
  ops.forEach((op, i) => {
    if (op.type !== "volume") return;
    const identity =
      (op.db !== undefined && op.db === 0) || (op.factor !== undefined && op.factor === 1);
    if (!identity) return;
    out.push({
      code: "NOOP_VOLUME",
      operation: i + 1,
      message:
        `volume: ${op.db !== undefined ? `db (${op.db})` : `factor (${op.factor})`} is the ` +
        `identity — the op parses but changes nothing`,
      fix: `remove operation ${i + 1} or set a non-identity gain`,
    });
  });
  return out;
}

/** NOOP_CUT — a cut whose removal range is degenerate vs the segments: the
 * kept time it removes is positive but < 0.01 s (MIN_SEGMENT — includes
 * start/end equal at 3 decimals), so subtraction changes nothing
 * observable. A cut removing nothing AT ALL is REDUNDANT_CUT's case. */
export function noopCuts(ops: Operation[], sourceDuration: number): Suggestion[] {
  const { steps } = cutTrace(ops, sourceDuration);
  const out: Suggestion[] = [];
  for (const step of steps) {
    if (!(step.removes > 0 && step.removes < MIN_CUT_EFFECT)) continue;
    const equalAt3 = step.range.start.toFixed(3) === step.range.end.toFixed(3);
    out.push({
      code: "NOOP_CUT",
      operation: step.n,
      message: equalAt3
        ? `cut ${fmt(step.range)} starts and ends at the same 3-decimal timestamp — it ` +
          `removes nothing observable`
        : `cut ${fmt(step.range)} removes only ${step.removes.toFixed(3)}s of kept time ` +
          `(below the ${MIN_CUT_EFFECT.toFixed(3)}s minimum) — a degenerate sliver`,
      fix: `remove operation ${step.n} or widen the cut to at least ${MIN_CUT_EFFECT.toFixed(3)}s of kept time`,
    });
  }
  return out;
}

/** OVERLAPPING_CUTS — two cuts whose removal ranges intersect with positive
 * length; pairwise, the LATER declared one is flagged. The subtraction math
 * handles overlaps correctly — this is hygiene, not validity (overlapping
 * cuts usually mean a double-bridge artifact). */
export function overlappingCuts(ops: Operation[]): Suggestion[] {
  const cuts = numberedRanges(ops, "cut");
  const out: Suggestion[] = [];
  for (let i = 0; i < cuts.length; i++) {
    for (let j = i + 1; j < cuts.length; j++) {
      const a = cuts[i]!;
      const b = cuts[j]!;
      const overlap = overlapLen(a.range, b.range);
      if (overlap <= 0) continue;
      out.push({
        code: "OVERLAPPING_CUTS",
        operation: b.n,
        message:
          `cut ${fmt(b.range)} overlaps cut ${fmt(a.range)} (operation ${a.n}) by ` +
          `${overlap.toFixed(3)}s — the subtraction handles it, but overlapping cuts are ` +
          `usually a double-bridge artifact`,
        fix: `remove operation ${b.n} or tighten it to not intersect operation ${a.n}`,
      });
    }
  }
  return out;
}

/** SUBSECOND_SEGMENT — a compiled keep-segment < 0.5 s: likely a bridge or
 * editing mistake. Compiled, not declared — no `operation` anchor; the
 * message names the segment bounds at 3 decimals. */
export function subsecondSegments(ops: Operation[], sourceDuration: number): Suggestion[] {
  const { final } = cutTrace(ops, sourceDuration);
  const out: Suggestion[] = [];
  for (const s of final) {
    const len = s.end - s.start;
    if (len >= SUBSECOND_SEGMENT_MIN) continue;
    out.push({
      code: "SUBSECOND_SEGMENT",
      message:
        `keep-segment ${fmt(s)} is only ${len.toFixed(3)}s (< ${SUBSECOND_SEGMENT_MIN.toFixed(3)}s) ` +
        `— likely a bridge or editing mistake`,
      fix: `grow the segment to at least ${SUBSECOND_SEGMENT_MIN.toFixed(3)}s or remove it via a cut/trim`,
    });
  }
  return out;
}

/** All seven rules over one operation list, in the deterministic report
 * order: by operation index (1-based declared; compiled-segment suggestions
 * without an operation sort last), then code (alphabetical), then generation
 * order — stable across runs. */
export function lintOperations(ops: Operation[], sourceDuration: number): Suggestion[] {
  const all = [
    ...redundantTrims(ops),
    ...redundantCuts(ops, sourceDuration),
    ...mergeableTrims(ops),
    ...noopVolume(ops),
    ...noopCuts(ops, sourceDuration),
    ...overlappingCuts(ops),
    ...subsecondSegments(ops, sourceDuration),
  ];
  return all
    .map((suggestion, i) => ({ suggestion, i }))
    .sort((x, y) => {
      const ox = x.suggestion.operation ?? Number.POSITIVE_INFINITY;
      const oy = y.suggestion.operation ?? Number.POSITIVE_INFINITY;
      if (ox !== oy) return ox < oy ? -1 : 1;
      if (x.suggestion.code !== y.suggestion.code) {
        return x.suggestion.code < y.suggestion.code ? -1 : 1;
      }
      return x.i - y.i;
    })
    .map(({ suggestion }) => suggestion);
}

// ---- file-level wrapper (the only I/O: the plan read + the metadata-cache
// probe validate already performs — no lint-owned cache, no new probes)

export type LintFileResult =
  | ({ valid: true } & LintReport)
  | { valid: false; validation: ValidationReport };

/** `video plan lint <plan>` — advisory pass over a VALID plan. An invalid
 * plan is a validate concern: the caller receives the EXISTING
 * ValidationReport (valid:false + its own error codes) and exits 1 — lint
 * never invalidates and never invents codes. */
export async function lintPlanFile(
  planPath: string,
  opts: CacheOpts = {},
): Promise<LintFileResult> {
  const validation = await validatePlan(planPath, opts);
  if (!validation.valid) return { valid: false, validation };
  return {
    valid: true,
    suggestions: lintOperations(
      validation.plan!.operations,
      validation.media!.duration,
    ),
  };
}
