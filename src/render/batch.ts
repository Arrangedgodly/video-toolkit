import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { ToolError, fail } from "../core/errors.js";
import { Cache } from "../cache/cache.js";
import { ffmpegVersion } from "../media/ffmpeg.js";
import { mapBounded, concurrencyFromBenchmark } from "../analysis/transcribe/index.js";
import { renderPlan, type RenderOpts, type RenderResult } from "./render.js";

/**
 * Bounded-parallel batch rendering (T22 — T5's mapBounded precedent applied to
 * the render path). Accepts plan file paths, directories (the `*.json` files
 * directly inside, non-recursive, sorted), or literal `*` globs (a minimal
 * deterministic matcher — the shell remains the primary expansion surface).
 * Each plan renders via `renderPlan` (its own overwrite/validation guards
 * intact); a failing or invalid plan is REPORTED in results[]/failures[] and
 * never thrown — the batch always runs to completion. Results are
 * index-aligned to the expanded input order regardless of completion order.
 */

export interface BatchPlanError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface BatchPlanOutcome {
  /** the plan path as it appears in the expanded list */
  plan: string;
  ok: boolean;
  /** rendered output path (shorthand; `result.output` is the same value) */
  output?: string;
  /** the full RenderResult on success */
  result?: RenderResult;
  /** the machine-readable error on failure (a ToolError toJSON shape) */
  error?: BatchPlanError;
}

export interface BatchReport {
  results: BatchPlanOutcome[];
  summary: {
    rendered: number;
    failed: number;
    failures: { plan: string; code: string; message: string }[];
    wallMs: number;
    jobs: number;
  };
}

export interface RenderBatchOpts extends RenderOpts {
  /** max plans rendered in parallel. Explicit value must be an integer ≥ 1
   * (no upper cap — the operator's own trade-off); default = the FIRST
   * plan's source cached `video benchmark` renderConcurrency recommendation
   * when an integer in 1..4, else 1 (T5's derivation mirrored). */
  jobs?: number;
  /** per-plan progress hook (the CLI writes `[i/N] <file>` lines to stderr) */
  onPlanStart?: (index: number, total: number, plan: string) => void;
  /** (T23) OVERALL-batch progress, overriding the inherited per-render
   * meaning: renderBatch never forwards this to renderPlan verbatim — each
   * render's engine events feed `createBatchProgressAggregator` and this
   * receives the raw overall = (Σ per-plan fractions)/N × 100 on every
   * accepted per-plan event and every plan completion (a finished plan —
   * success OR captured failure — locks its fraction at 1; not-yet-started
   * plans hold 0). Never called with `percent: null` (the aggregate is
   * always known); values are RAW — the consumer's sink owns throttling and
   * monotonicity (R6: policy is a transport concern, exactly as for
   * `video_render`). Each event also carries the formatted T26 `message`
   * naming the in-flight plan (see `BatchProgressEvent`); absent (CLI,
   * stdio) = the aggregation no-ops entirely. */
  onProgress?: (p: { percent: number | null; timeSec: number }) => void;
}

/** (T23) one aggregated overall-batch progress event: `percent` = (Σ per-plan
 * fractions)/N × 100 (finite by construction), `timeSec` = the triggering
 * plan's own engine time (its last known value on completion) so a consumer's
 * message names the in-flight render. (T26) `message` = the FIXED display
 * template `plan i/N (<basename>): P% — overall O%` — `i` the triggering
 * plan's 1-based index in the EXPANDED plan order, `<basename>` =
 * `path.basename(planPath)` (the CLI stderr precedent), `P` the triggering
 * plan's OWN current percent as a Math.round integer (its fraction — locked
 * at 1 → `100` on a completion event), `O` the overall aggregate as a
 * Math.round integer. Deterministic by construction: same inputs → same
 * string; `timeSec` stays for consumers that don't read `message`. */
export interface BatchProgressEvent {
  percent: number;
  timeSec: number;
  message: string;
}

export interface BatchProgressAggregator {
  /** feed one RAW per-plan engine event (`percent: null` skipped — R6) */
  planEvent: (index: number, p: { percent: number | null; timeSec: number }) => void;
  /** plan `index` finished (success OR captured failure) — fraction locks at 1 */
  planComplete: (index: number) => void;
}

/** Pure overall-batch progress aggregator (T23): combines the per-plan
 * onProgress streams of parallel renders into ONE 0–100 value. Deterministic
 * by construction — no clock, no randomness: the same event sequence yields
 * the same overall sequence (unit-locked). The raw overall is forwarded on
 * every accepted event INCLUDING possible regressions (a slow plan's engine
 * percent can dip mid-run); the transport sink's monotonic gate is the
 * guaranteed fence, exactly as for `video_render` (the plan entry's recorded
 * division of labor). `planPaths` = the EXPANDED plan list (length = N,
 * entries = display names via basename — T26); `max` keeps the pure function
 * safe for direct unit use with `totalPlans ≥ 1` guaranteed by renderBatch
 * (an empty expansion fails OPERATION_INVALID before an aggregator exists;
 * an index fed beyond the array degrades to a deterministic `plan-i` name —
 * unreachable via renderBatch). A single-plan batch degrades to exactly
 * `video_render`'s raw stream (fraction = percent/100, so overall = percent;
 * the engine parse already clamps to ≤ 100 — the fraction clamp is the
 * defensive mirror). No synthetic final-100 event: when the last plan
 * completes the overall IS exactly 100, forwarded through the consumer's
 * normal gates (the response frame is completion). */
export function createBatchProgressAggregator(
  planPaths: readonly string[],
  emit: (p: BatchProgressEvent) => void,
): BatchProgressAggregator {
  const n = Math.max(1, Math.floor(planPaths.length));
  const names = planPaths.map((p) => path.basename(p));
  const fractions = new Array<number>(n).fill(0);
  const lastTimeSec = new Array<number>(n).fill(0);
  const forward = (index: number): void => {
    let sum = 0;
    for (const f of fractions) sum += f;
    const overall = (sum / n) * 100;
    const planPct = (fractions[index] ?? 0) * 100;
    // (T26) FIXED display template — the exact spelling is contract (AGENTS):
    // `plan i/N (basename): P% — overall O%`, both percents Math.round ints
    emit({
      percent: overall,
      timeSec: lastTimeSec[index] ?? 0,
      message: `plan ${index + 1}/${n} (${names[index] ?? `plan-${index + 1}`}): ${Math.round(planPct)}% — overall ${Math.round(overall)}%`,
    });
  };
  return {
    planEvent: (index, p) => {
      if (p.percent === null || !Number.isFinite(p.percent)) return; // R6 skip
      lastTimeSec[index] = p.timeSec;
      fractions[index] = Math.min(1, Math.max(0, p.percent / 100));
      forward(index);
    },
    planComplete: (index) => {
      fractions[index] = 1;
      forward(index);
    },
  };
}

function hasWildcard(p: string): boolean {
  return p.includes("*");
}

/** minimal deterministic glob: `*` matches any run of non-separator chars
 * within ONE path segment; no `?`, no `[]`, no `**` (recorded decision — the
 * shell remains the expansion surface for anything richer). */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`);
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

/** Expand plan args (files, directories, `*` globs) into the deterministic
 * plan list. Per-arg expansions are sorted by name; arg order is preserved
 * (the summary follows this order). A literal path that does not exist is
 * carried through verbatim so its per-plan failure is REPORTED, not thrown
 * (the same never-stop semantics as a plan that fails validation). A glob
 * with no matches contributes nothing. Exported for unit tests. */
export async function expandPlanArgs(args: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const arg of args) {
    if (hasWildcard(arg)) {
      const dir = path.dirname(arg);
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        continue; // unreadable/absent directory → no matches
      }
      const re = globToRegExp(path.basename(arg));
      const matches: string[] = [];
      for (const name of entries) {
        if (!re.test(name)) continue;
        const full = path.join(dir, name);
        if (await isFile(full)) matches.push(full);
      }
      matches.sort();
      out.push(...matches);
      continue;
    }
    let st: Awaited<ReturnType<typeof stat>>;
    try {
      st = await stat(arg);
    } catch {
      out.push(arg); // nonexistent literal — its render reports the error
      continue;
    }
    if (st.isDirectory()) {
      // directory arg: the *.json FILES directly inside, non-recursive, sorted
      const names = (await readdir(arg)).filter((n) => n.endsWith(".json"));
      const files: string[] = [];
      for (const name of names) {
        const full = path.join(arg, name);
        if (await isFile(full)) files.push(full);
      }
      files.sort();
      out.push(...files);
    } else {
      out.push(arg); // literal file (any extension) — carried through
    }
  }
  return out;
}

/** Default jobs = the FIRST plan's source cached benchmark recommendation
 * (the same cache file `video benchmark` writes), via T5's
 * `concurrencyFromBenchmark` clamp; anything unreadable/insane → 1. Pure
 * fallback semantics — a plan whose source/benchmark cannot be read simply
 * renders with the conservative default (its own failure, if any, is
 * reported per-plan like every other). */
async function defaultJobs(firstPlan: string): Promise<number> {
  try {
    const doc = JSON.parse(await readFile(firstPlan, "utf8")) as { source?: unknown };
    if (typeof doc.source !== "string") return 1;
    const cache = new Cache();
    const id = await cache.sourceId(doc.source);
    const bench = await cache.read(id, `benchmark-${await ffmpegVersion("ffmpeg")}.json`);
    return concurrencyFromBenchmark(bench);
  } catch {
    return 1;
  }
}

function toBatchError(e: unknown): BatchPlanError {
  if (e instanceof ToolError) return e.toJSON();
  return { code: "INTERNAL", message: e instanceof Error ? e.message : String(e) };
}

export async function renderBatch(args: string[], opts: RenderBatchOpts = {}): Promise<BatchReport> {
  if (opts.jobs !== undefined && (!Number.isInteger(opts.jobs) || opts.jobs < 1)) {
    fail("OPERATION_INVALID", `--jobs must be an integer >= 1, got ${opts.jobs}`, {
      jobs: opts.jobs,
    });
  }
  const started = Date.now();
  const plans = await expandPlanArgs(args);
  if (plans.length === 0) {
    fail("OPERATION_INVALID", `no plan files found for: ${args.join(" ")}`, { args });
  }
  const jobs = opts.jobs ?? (await defaultJobs(plans[0]!));
  const debug = opts.debug ?? (() => {});
  debug(`render-batch: ${plans.length} plan(s), jobs=${jobs}`);
  // (T23) overall-batch progress — constructed only when a sink is attached,
  // so the CLI/stdio paths take the identical no-aggregator code path.
  // (T26) the aggregator gets the EXPANDED plan paths: N = plans.length and
  // each event's `message` names the in-flight plan by basename.
  const aggregator = opts.onProgress
    ? createBatchProgressAggregator(plans, opts.onProgress)
    : undefined;

  // Every item is wrapped so a validation/render failure is CAPTURED per
  // plan — mapBounded's lowest-index-throw semantics never engage; the batch
  // always runs to completion and the summary carries every failure.
  const results = await mapBounded(
    plans,
    jobs,
    async (plan, i): Promise<BatchPlanOutcome> => {
      opts.onPlanStart?.(i, plans.length, plan);
      try {
        const result = await renderPlan(plan, {
          mode: opts.mode,
          force: opts.force,
          encoder: opts.encoder,
          noCache: opts.noCache,
          debug: opts.debug,
          onProgress: aggregator ? (p) => aggregator.planEvent(i, p) : undefined,
        });
        return { plan, ok: true, output: result.output, result };
      } catch (e) {
        return { plan, ok: false, error: toBatchError(e) };
      } finally {
        // finished is finished — success or captured failure locks at 1
        aggregator?.planComplete(i);
      }
    },
  );

  const failures = results
    .filter((r) => !r.ok)
    .map((r) => ({ plan: r.plan, code: r.error!.code, message: r.error!.message }));

  return {
    results,
    summary: {
      rendered: results.length - failures.length,
      failed: failures.length,
      failures,
      wallMs: Date.now() - started,
      jobs,
    },
  };
}
