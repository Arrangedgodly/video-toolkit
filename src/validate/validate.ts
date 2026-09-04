import { stat } from "node:fs/promises";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { ToolError, fail, type ErrorCode } from "../core/errors.js";
import { EditPlan, schemaIssues, type EditPlan as EditPlanType } from "../core/schemas.js";
import { adjustedDuration, compileTimeline, totalDuration, type Segment } from "../core/timeline.js";
import { cachedInspect, type CacheOpts } from "../cache/cache.js";
import type { MediaInfo } from "../media/ffprobe.js";
import { OVERLAY_FONT_FILE } from "../media/ffmpeg.js";

export interface ValidationIssue {
  code: string;
  operation?: number;
  path?: string;
  message: string;
}

export interface ValidationReport {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  plan?: EditPlanType;
  media?: MediaInfo;
  timeline?: Segment[];
  timelineDuration?: number;
  /** the crossfade op's fade duration, present when the plan carries one */
  crossfadeDuration?: number;
  /** crossfade-adjusted expectation = timelineDuration − (N−1)·fade
   * (pre-speed; present only when a crossfade op is in the plan) */
  expectedDuration?: number;
}

export async function loadPlan(planPath: string): Promise<EditPlanType> {
  let text: string;
  try {
    text = await readFile(planPath, "utf8");
  } catch {
    fail("SOURCE_NOT_FOUND", `plan file not found: ${planPath}`);
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    fail("PLAN_INVALID_JSON", `plan is not valid JSON: ${(e as Error).message}`);
  }
  const parsed = EditPlan.safeParse(doc);
  if (!parsed.success) {
    throw new ToolError("PLAN_SCHEMA_INVALID", "plan does not match the edit-plan schema", {
      issues: schemaIssues(parsed.error),
    });
  }
  return parsed.data;
}

const DURATION_TOLERANCE = 0.05; // timestamps may touch the end within one frame

export async function validatePlan(
  planPath: string,
  opts: CacheOpts = {},
): Promise<ValidationReport> {
  const plan = await loadPlan(planPath);
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const report: ValidationReport = { valid: false, errors, warnings, plan };

  // source exists + is readable media
  try {
    await stat(plan.source);
  } catch {
    errors.push({ code: "SOURCE_NOT_FOUND", message: `source not found: ${plan.source}` });
    return { ...report, valid: false };
  }
  const media = await cachedInspect(plan.source, opts);
  report.media = media;

  // per-operation range checks against real media facts
  const seenTransforms = new Map<string, number>();
  for (let index = 0; index < plan.operations.length; index++) {
    const op = plan.operations[index]!;
    const i = index;
    if (op.type === "trim" || op.type === "cut") {
      const label = op.type;
      if (op.start >= op.end) {
        errors.push({
          code: "RANGE_NEGATIVE",
          operation: i + 1,
          message: `${label}: start (${op.start}) must be before end (${op.end})`,
        });
      }
      const max = media.duration + DURATION_TOLERANCE;
      if (op.start > max || op.end > max) {
        errors.push({
          code: "TIMESTAMP_OUT_OF_RANGE",
          operation: i + 1,
          message: `${label}: range [${op.start}, ${op.end}] exceeds source duration ${media.duration.toFixed(3)}s`,
        });
      }
    }
    if (
      op.type === "speed" ||
      op.type === "resize" ||
      op.type === "volume" ||
      op.type === "captions" ||
      op.type === "overlay-text" ||
      op.type === "audio-mix" ||
      op.type === "crossfade"
    ) {
      const first = seenTransforms.get(op.type);
      if (first !== undefined) {
        errors.push({
          code: "OPERATION_INVALID",
          operation: i + 1,
          message: `duplicate ${op.type} operation (already set by operation ${first}); at most one is allowed`,
        });
      } else {
        seenTransforms.set(op.type, i + 1);
      }
      if (op.type === "volume") {
        const hasDb = op.db !== undefined;
        const hasFactor = op.factor !== undefined;
        if (hasDb === hasFactor) {
          errors.push({
            code: "OPERATION_INVALID",
            operation: i + 1,
            message: "volume needs exactly one of 'db' or 'factor'",
          });
        }
      }
      if (op.type === "captions") {
        try {
          await stat(op.file);
        } catch {
          errors.push({
            code: "OPERATION_INVALID",
            operation: i + 1,
            message: `captions: subtitle file not found: ${op.file}`,
          });
        }
      }
      if (op.type === "overlay-text") {
        if (op.from !== undefined && op.to !== undefined && op.from >= op.to) {
          errors.push({
            code: "RANGE_NEGATIVE",
            operation: i + 1,
            message: `overlay-text: from (${op.from}) must be before to (${op.to})`,
          });
        }
        // the font is a machine fact, not plan data — but the failure must be
        // machine-readable before render spends an ffmpeg pass on it
        try {
          await stat(OVERLAY_FONT_FILE);
        } catch {
          errors.push({
            code: "OPERATION_INVALID",
            operation: i + 1,
            message: `overlay-text: font file not found: ${OVERLAY_FONT_FILE}`,
          });
        }
      }
      if (op.type === "crossfade" && op.kind === "custom") {
        // T17 fence: `custom` is the xfade enum sentinel (value −1) — it
        // names an expr-driven transition and is not usable standalone; the
        // schema parses it ONLY so this fence can say why (an actionable
        // error beats a 59-value enum dump)
        errors.push({
          code: "OPERATION_INVALID",
          operation: i + 1,
          message:
            "crossfade: kind 'custom' is the xfade expr= sentinel — it is not a standalone transition " +
            "(the plan op does not expose expr=); pick a catalog kind via `video transitions`",
        });
      }
      if (op.type === "audio-mix") {
        try {
          await stat(op.file);
        } catch {
          errors.push({
            code: "MIX_INPUT_NOT_FOUND",
            operation: i + 1,
            path: op.file,
            message: `audio-mix: bed file not found: ${op.file}`,
          });
        }
      }
    }
  }
  const captionsOp = plan.operations.find(
    (op): op is Extract<(typeof plan.operations)[number], { type: "captions" }> =>
      op.type === "captions",
  );
  const overlayTextOp = plan.operations.find(
    (op): op is Extract<(typeof plan.operations)[number], { type: "overlay-text" }> =>
      op.type === "overlay-text",
  );
  const crossfadeOp = plan.operations.find(
    (op): op is Extract<(typeof plan.operations)[number], { type: "crossfade" }> =>
      op.type === "crossfade",
  );
  const audioMixOp = plan.operations.find(
    (op): op is Extract<(typeof plan.operations)[number], { type: "audio-mix" }> =>
      op.type === "audio-mix",
  );
  if ((captionsOp || overlayTextOp) && errors.length === 0) {
    const { hasFilter } = await import("../media/ffmpeg.js");
    if (captionsOp && !(await hasFilter("subtitles"))) {
      errors.push({
        code: "OPERATION_INVALID",
        operation: plan.operations.indexOf(captionsOp) + 1,
        message:
          "captions: this ffmpeg build lacks the 'subtitles' filter (libass); install a full build and retry",
      });
    }
    if (overlayTextOp && !(await hasFilter("drawtext"))) {
      errors.push({
        code: "OPERATION_INVALID",
        operation: plan.operations.indexOf(overlayTextOp) + 1,
        message:
          "overlay-text: this ffmpeg build lacks the 'drawtext' filter (freetype); install a full build and retry",
      });
    }
  }
  if (errors.length > 0) return { ...report, valid: false };

  // timeline compiles to something non-empty
  try {
    const timeline = compileTimeline(plan.operations, media.duration);
    report.timeline = timeline;
    report.timelineDuration = totalDuration(timeline);
  } catch (e) {
    if (e instanceof ToolError && e.code === "EMPTY_TIMELINE") {
      errors.push({ code: "EMPTY_TIMELINE", message: e.message });
      return { ...report, valid: false };
    }
    throw e;
  }

  // crossfade bounds — CLIENT-SIDE VALIDATION IS LOAD-BEARING (R3's
  // constraints table): ffmpeg exits 0 with silently corrupted output when
  // the fade reaches a segment length or drops below one frame
  if (crossfadeOp && report.timeline) {
    const timeline = report.timeline;
    const opIndex = plan.operations.indexOf(crossfadeOp) + 1;
    const d = crossfadeOp.duration;
    // nothing to transition
    if (timeline.length < 2) {
      errors.push({
        code: "OPERATION_INVALID",
        operation: opIndex,
        message: `crossfade: timeline compiles to ${timeline.length} keep-segment; a crossfade needs at least 2`,
      });
    } else {
      // floor: sub-frame fades corrupt silently (0.05 s sensible floor; never
      // below one source frame — the stricter of the two governs)
      const fps = media.video?.fps ?? 0;
      const floor = Math.max(0.05, fps > 0 ? 1 / fps : 0);
      if (d < floor) {
        errors.push({
          code: "OPERATION_INVALID",
          operation: opIndex,
          message: `crossfade: duration (${d}) is below the ${floor.toFixed(3)}s floor (sub-frame fades corrupt silently; 2 frames (${fps > 0 ? (2 / fps).toFixed(3) + "s" : "0.067s"}) is the perceptible minimum)`,
        });
      }
      // fade must leave EVERY segment with positive pure content — name the
      // offender (shortest segment) so the agent knows which trim to grow
      let shortest = 0;
      for (let k = 1; k < timeline.length; k++) {
        if (timeline[k]!.end - timeline[k]!.start < timeline[shortest]!.end - timeline[shortest]!.start) {
          shortest = k;
        }
      }
      const shortestLen = timeline[shortest]!.end - timeline[shortest]!.start;
      if (d >= shortestLen) {
        errors.push({
          code: "OPERATION_INVALID",
          operation: opIndex,
          message:
            `crossfade: duration (${d}) must be shorter than EVERY keep-segment — ` +
            `segment ${shortest + 1} [${timeline[shortest]!.start.toFixed(3)}, ${timeline[shortest]!.end.toFixed(3)}] is only ${shortestLen.toFixed(3)}s ` +
            `(a fade that long silently corrupts the output; the shrinkage also has to stay ≥ 0)`,
        });
      }
      // one canonical duration law feeds progress/verify + the overlay bound
      report.crossfadeDuration = d;
      report.expectedDuration = adjustedDuration(timeline, d);
    }
    // crossfade + audio-mix is not a validated composition (R3's matrix has
    // no sidechain-ducking row) — reject rather than compose blind
    if (audioMixOp) {
      errors.push({
        code: "OPERATION_INVALID",
        operation: opIndex,
        message: `crossfade + audio-mix in one plan is not a supported composition (the sidechain-ducking graph was never validated against the transition chain); drop one of the two`,
      });
    }
  }

  // overlay-text `to` lives on the OUTPUT timeline — bound it by the expected
  // output duration ((timeline − crossfade shrinkage) / speed; the same
  // canonical expectation the render progress/verify stages use)
  if (overlayTextOp && overlayTextOp.to !== undefined) {
    const speedOp = plan.operations.find(
      (op): op is Extract<(typeof plan.operations)[number], { type: "speed" }> =>
        op.type === "speed",
    );
    const base = report.expectedDuration ?? report.timelineDuration ?? 0;
    const expectedOutput = speedOp ? base / speedOp.factor : base;
    if (overlayTextOp.to > expectedOutput + DURATION_TOLERANCE) {
      errors.push({
        code: "OPERATION_INVALID",
        operation: plan.operations.indexOf(overlayTextOp) + 1,
        message: `overlay-text: to (${overlayTextOp.to}) exceeds expected output duration ${expectedOutput.toFixed(3)}s`,
      });
    }
  }

  // output path sanity
  const absOut = path.resolve(plan.output.path);
  const absSource = path.resolve(plan.source);
  if (absOut === absSource) {
    errors.push({
      code: "OUTPUT_WOULD_OVERWRITE_SOURCE",
      message: "output path would overwrite the source file",
    });
  }
  const parent = path.dirname(absOut);
  try {
    const st = await stat(parent);
    if (!st.isDirectory()) {
      errors.push({ code: "OUTPUT_PATH_INVALID", message: `output parent is not a directory: ${parent}` });
    }
  } catch {
    errors.push({ code: "OUTPUT_PATH_INVALID", message: `output parent directory does not exist: ${parent}` });
  }
  try {
    await stat(absOut);
    warnings.push({
      code: "OUTPUT_EXISTS",
      message: `output exists: ${absOut} (render will refuse without --force)`,
    });
  } catch {
    // absent — good
  }

  // audio ops without an audio stream are silent no-ops — say so
  if (!media.audio) {
    const audioOps = plan.operations
      .map((op, i) => ({ op, i: i + 1 }))
      .filter(({ op }) => op.type === "normalize-audio" || op.type === "volume" || op.type === "audio-mix");
    if (audioOps.length > 0) {
      warnings.push({
        code: "NO_AUDIO_STREAM",
        message: `source has no audio stream; ${audioOps.map(({ op }) => op.type).join(", ")} would be no-ops`,
      });
    }
  }

  return { ...report, valid: errors.length === 0 };
}
