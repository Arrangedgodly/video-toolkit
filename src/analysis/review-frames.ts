import { mkdir } from "node:fs/promises";
import path from "node:path";
import { SceneReport } from "../core/schemas.js";
import type { z } from "zod";
import { ToolError } from "../core/errors.js";
import { cachedInspect, type CacheOpts } from "../cache/cache.js";
import { extractStill } from "./frames.js";
import { round3 } from "./runner.js";

export interface ReviewFramesParams {
  /** stills per scene boundary (editorial default: 4) */
  perBoundary: number;
  /** seconds of source covered around each boundary (editorial default: 1.5) */
  window: number;
}

export interface ReviewGroupPlan {
  boundary: number;
  times: number[];
}

/**
 * Grouping math for scene review: per boundary, `perBoundary` timestamps
 * evenly spaced (interval midpoints, like extract-frame's `--count`) inside
 * [boundary − window/2, boundary + window/2] clamped to [0, duration].
 * Boundaries whose clamped range collapses (fully outside the source) drop.
 * Pure and deterministic — the editorial decisions are the parameters.
 */
export function planReviewGroups(
  report: z.infer<typeof SceneReport>,
  sourceDuration: number,
  params: ReviewFramesParams,
): { groups: ReviewGroupPlan[]; note?: string } {
  if (!Number.isInteger(params.perBoundary) || params.perBoundary < 1) {
    throw new ToolError("OPERATION_INVALID", "review-frames: --per-boundary must be an integer >= 1");
  }
  if (!(params.window > 0)) {
    throw new ToolError("OPERATION_INVALID", "review-frames: --window must be > 0");
  }

  const groups: ReviewGroupPlan[] = [];
  for (const b of report.boundaries) {
    const start = Math.max(0, b.timestamp - params.window / 2);
    const end = Math.min(sourceDuration, b.timestamp + params.window / 2);
    if (start >= end) continue; // boundary fully outside the source
    const width = end - start;
    const times = Array.from(
      { length: params.perBoundary },
      (_, i) => round3(start + ((i + 0.5) * width) / params.perBoundary),
    );
    groups.push({ boundary: round3(b.timestamp), times });
  }

  if (report.boundaries.length === 0) {
    return { groups, note: "no scene boundaries in report" };
  }
  if (groups.length === 0) {
    return { groups, note: "all boundaries outside the source duration" };
  }
  return { groups };
}

export interface ReviewFramesResult {
  dir: string;
  groups: { boundary: number; frames: string[] }[];
  note?: string;
}

/** Extract grouped stills around every scene boundary for agent visual
 * review. Reuses the extract-frame extraction internals; no own cache —
 * fresh stills on demand (like generate-proxy). Observes only, never
 * renders, never touches the source. */
export async function reviewFrames(
  input: string,
  report: z.infer<typeof SceneReport>,
  opts: CacheOpts & { perBoundary?: number; window?: number; size?: number; dir?: string } = {},
): Promise<ReviewFramesResult> {
  const media = await cachedInspect(input, opts);
  const debug = opts.debug ?? (() => {});
  if (!media.video) {
    throw Object.assign(new Error("review-frames needs a video stream"), { code: "UNSUPPORTED_MEDIA" });
  }

  const params: ReviewFramesParams = {
    perBoundary: opts.perBoundary ?? 4,
    window: opts.window ?? 1.5,
  };
  const size = opts.size ?? 480;

  const { groups: planned, note } = planReviewGroups(report, media.duration, params);

  const stem = path.basename(input).replace(/\.[^.]+$/, "");
  const dir = opts.dir ?? `${stem}-review`;
  await mkdir(dir, { recursive: true });

  const groups: { boundary: number; frames: string[] }[] = [];
  for (let g = 0; g < planned.length; g++) {
    const plan = planned[g]!;
    const frames: string[] = [];
    for (let i = 0; i < plan.times.length; i++) {
      const t = plan.times[i]!;
      const out = path.join(
        dir,
        `boundary_${String(g + 1).padStart(3, "0")}_f${i + 1}_${t.toFixed(3)}.jpg`,
      );
      const ms = await extractStill(input, t, out, size);
      debug(`boundary ${g + 1}/${planned.length} frame ${i + 1}/${plan.times.length} @${t.toFixed(3)}s (${ms}ms)`);
      frames.push(path.resolve(out));
    }
    groups.push({ boundary: plan.boundary, frames });
  }
  return { dir: path.resolve(dir), groups, ...(note ? { note } : {}) };
}
