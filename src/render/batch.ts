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
        });
        return { plan, ok: true, output: result.output, result };
      } catch (e) {
        return { plan, ok: false, error: toBatchError(e) };
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
