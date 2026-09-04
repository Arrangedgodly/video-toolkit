import path from "node:path";
import { stat } from "node:fs/promises";
import { ToolError, fail, type ErrorCode } from "../core/errors.js";
import { buildRenderCommand, channelLayoutFor, runFFmpeg, type EncoderId, type MixOptions } from "../media/ffmpeg.js";
import { inspectFile } from "../media/ffprobe.js";
import { validatePlan } from "../validate/validate.js";
import type { CacheOpts } from "../cache/cache.js";

export type RenderMode = "final" | "preview";

export interface RenderOpts extends CacheOpts {
  mode?: RenderMode;
  force?: boolean;
  encoder?: EncoderId;
  onProgress?: (p: { percent: number | null; timeSec: number }) => void;
}

export interface RenderResult {
  output: string;
  mode: RenderMode;
  encoder: EncoderId;
  timelineSegments: number;
  timelineDuration: number;
  outputDuration: number;
  wallMs: number;
  command: string[];
}

const SETTINGS: Record<
  RenderMode,
  { crf: number; preset: string; audioBitrate: string; scaleWidth?: number }
> = {
  preview: { crf: 30, preset: "ultrafast", audioBitrate: "96k", scaleWidth: 640 },
  final: { crf: 18, preset: "medium", audioBitrate: "192k" },
};

const VALIDATION_CODES: ErrorCode[] = [
  "PLAN_INVALID_JSON",
  "PLAN_SCHEMA_INVALID",
  "SOURCE_NOT_FOUND",
  "TIMESTAMP_OUT_OF_RANGE",
  "RANGE_NEGATIVE",
  "EMPTY_TIMELINE",
  "OUTPUT_PATH_INVALID",
  "OUTPUT_WOULD_OVERWRITE_SOURCE",
  "OPERATION_INVALID",
  "MIX_INPUT_NOT_FOUND",
];

/** preview output lives beside the final path and can never clobber it */
export function previewPathFor(outputPath: string): string {
  const dir = path.dirname(outputPath);
  const ext = path.extname(outputPath) || ".mp4";
  const base = path.basename(outputPath, ext);
  return path.join(dir, `${base}.preview${ext}`);
}

export async function renderPlan(planPath: string, opts: RenderOpts = {}): Promise<RenderResult> {
  const debug = opts.debug ?? (() => {});
  const started = Date.now();
  let t = Date.now();
  const lap = (name: string) => {
    debug(`stage ${name}: ${Date.now() - t}ms`);
    t = Date.now();
  };

  const report = await validatePlan(planPath, opts);
  lap("validate");
  if (!report.valid || !report.plan || !report.media || !report.timeline || !report.timelineDuration) {
    const first = report.errors[0];
    const code = VALIDATION_CODES.includes(first?.code as ErrorCode)
      ? (first?.code as ErrorCode)
      : "PLAN_SCHEMA_INVALID";
    throw new ToolError(code, "edit plan failed validation", { errors: report.errors });
  }
  const plan = report.plan;
  const mode: RenderMode = opts.mode ?? plan.output.mode;
  const encoder: EncoderId = opts.encoder ?? "libx264";
  const settings = SETTINGS[mode];
  const output = mode === "preview" ? previewPathFor(plan.output.path) : plan.output.path;

  if (!opts.force) {
    try {
      await stat(output);
      fail("OUTPUT_EXISTS", `output exists: ${output} (use --force to overwrite)`);
    } catch (e) {
      if (e instanceof ToolError) throw e; // OUTPUT_EXISTS from above
      // ENOENT: output absent — proceed
    }
  }

  const normalizeOp = plan.operations.find(
    (op): op is Extract<(typeof plan.operations)[number], { type: "normalize-audio" }> =>
      op.type === "normalize-audio",
  );
  const speedOp = plan.operations.find(
    (op): op is Extract<(typeof plan.operations)[number], { type: "speed" }> =>
      op.type === "speed",
  );
  const resizeOp = plan.operations.find(
    (op): op is Extract<(typeof plan.operations)[number], { type: "resize" }> =>
      op.type === "resize",
  );
  const volumeOp = plan.operations.find(
    (op): op is Extract<(typeof plan.operations)[number], { type: "volume" }> =>
      op.type === "volume",
  );
  const captionsOp = plan.operations.find(
    (op): op is Extract<(typeof plan.operations)[number], { type: "captions" }> =>
      op.type === "captions",
  );
  const overlayTextOp = plan.operations.find(
    (op): op is Extract<(typeof plan.operations)[number], { type: "overlay-text" }> =>
      op.type === "overlay-text",
  );
  const audioMixOp = plan.operations.find(
    (op): op is Extract<(typeof plan.operations)[number], { type: "audio-mix" }> =>
      op.type === "audio-mix",
  );
  const hasAudio = report.media.audio != null;
  const speedFactor = speedOp?.factor;

  // resize and preview both scale; when both apply, use the smaller width so
  // preview stays cheap — unless the resize is exact (w×h), which wins
  let scaleWidth = settings.scaleWidth;
  let scaleHeight: number | undefined;
  if (resizeOp) {
    scaleWidth = resizeOp.width;
    scaleHeight = resizeOp.height;
    if (scaleHeight === undefined && settings.scaleWidth !== undefined) {
      scaleWidth = Math.min(resizeOp.width, settings.scaleWidth);
    }
  }

  // expected output duration = timeline / speed; the mix bed's atrim bound
  // needs it before the command is built (R1 record: atrim is the determinism
  // bound on the looped bed)
  const expectedDuration = speedFactor
    ? report.timelineDuration / speedFactor
    : report.timelineDuration;

  // mix plumbing is pure declaration: bed file + level + duck params, the
  // atrim bound, and the speech stream's OWN rate/layout from the already-
  // probed media info — the bed conforms to the speech, never the reverse,
  // and no new probes happen (defaults per R1's committed parameter table)
  let mix: MixOptions | null = null;
  if (audioMixOp && hasAudio && report.media.audio) {
    const audio = report.media.audio;
    mix = {
      bedFile: audioMixOp.file,
      levelDb: audioMixOp.level ?? -18,
      duck: {
        threshold: audioMixOp.duck?.threshold ?? 0.02,
        ratio: audioMixOp.duck?.ratio ?? 8,
        attack: audioMixOp.duck?.attack ?? 20,
        release: audioMixOp.duck?.release ?? 400,
        makeup: audioMixOp.duck?.makeup,
      },
      bedTrimSeconds: expectedDuration,
      speechSampleRate: audio.sampleRate,
      speechLayout: channelLayoutFor(audio.channels),
    };
  }

  const command = buildRenderCommand(
    plan.source,
    report.timeline,
    output,
    {
      encoder,
      crf: settings.crf,
      preset: settings.preset,
      videoBitrate: "10M",
      audioBitrate: settings.audioBitrate,
      scaleWidth,
      scaleHeight,
      normalizeLufs: normalizeOp && hasAudio ? (normalizeOp.target ?? -16) : null,
      speedFactor,
      volumeDb:
        volumeOp && hasAudio
          ? volumeOp.db !== undefined
            ? volumeOp.db
            : 20 * Math.log10(volumeOp.factor ?? 1)
          : null,
      subtitleFile: captionsOp?.file,
      subtitleStyle: captionsOp?.style,
      // overlay-text defaults: position bottom, 48 px, white, boxed
      overlayText: overlayTextOp
        ? {
            text: overlayTextOp.text,
            from: overlayTextOp.from,
            to: overlayTextOp.to,
            position: overlayTextOp.position ?? "bottom",
            fontsize: overlayTextOp.fontsize ?? 48,
            color: overlayTextOp.color ?? "white",
            box: overlayTextOp.box ?? true,
          }
        : undefined,
      mix,
    },
    hasAudio,
  );
  debug(`command: ${command.join(" ")}`);

  const run = await runFFmpeg(command.slice(1), {
    expectedDuration,
    onProgress: opts.onProgress,
  });
  lap("ffmpeg");

  const outInfo = await inspectFile(output);
  lap("verify");
  // compare against the speed-adjusted expectation (the same value the
  // progress math and the mix bed's atrim bound use) — a correct sped-up
  // render must not warn; only a genuinely wrong duration should
  if (Math.abs(outInfo.duration - expectedDuration) > 1.0) {
    debug(
      `warning: output duration ${outInfo.duration.toFixed(2)}s differs from expected ${expectedDuration.toFixed(2)}s`,
    );
  }

  return {
    output: path.resolve(output),
    mode,
    encoder,
    timelineSegments: report.timeline.length,
    timelineDuration: report.timelineDuration,
    outputDuration: outInfo.duration,
    wallMs: Date.now() - started,
    command: run.command,
  };
}
