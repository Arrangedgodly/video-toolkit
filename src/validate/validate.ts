import { stat } from "node:fs/promises";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { ToolError, fail, type ErrorCode } from "../core/errors.js";
import { EditPlan, schemaIssues, type EditPlan as EditPlanType } from "../core/schemas.js";
import { compileTimeline, totalDuration, type Segment } from "../core/timeline.js";
import { cachedInspect, type CacheOpts } from "../cache/cache.js";
import type { MediaInfo } from "../media/ffprobe.js";

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
      op.type === "audio-mix"
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
  if (captionsOp && errors.length === 0) {
    const { hasFilter } = await import("../media/ffmpeg.js");
    if (!(await hasFilter("subtitles"))) {
      errors.push({
        code: "OPERATION_INVALID",
        operation: plan.operations.indexOf(captionsOp) + 1,
        message:
          "captions: this ffmpeg build lacks the 'subtitles' filter (libass); install a full build and retry",
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
