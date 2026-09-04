import { z } from "zod";

/** Timestamps are seconds since source start, as plain numbers. Every layer
 * (plans, observations, reports) uses the same convention. */

const TimeRange = z.object({
  start: z.number().min(0),
  end: z.number().min(0),
});

/** trim = KEEP [start, end] on the source timeline. Multiple trims union. */
export const TrimOp = TimeRange.extend({ type: z.literal("trim") });

/** cut = REMOVE [start, end] from whatever the trims kept. */
export const CutOp = TimeRange.extend({ type: z.literal("cut") });

/** Single-pass EBU R128 loudness normalization (dynamic mode). */
export const NormalizeAudioOp = z.object({
  type: z.literal("normalize-audio"),
  /** Target integrated loudness in LUFS. Default -16 (online video norm). */
  target: z.number().min(-40).max(-5).optional(),
});

/** Global playback speed. Exactly one per plan; audio follows via atempo. */
export const SpeedOp = z.object({
  type: z.literal("speed"),
  factor: z.number().gt(0).max(10),
});

/** Global resize. Exactly one per plan; width-only keeps aspect ratio. */
export const ResizeOp = z.object({
  type: z.literal("resize"),
  width: z.number().int().gt(0).max(16384),
  height: z.number().int().gt(0).max(16384).optional(),
});

/** Global audio gain. Exactly one per plan; exactly one of db or factor. */
export const VolumeOp = z.object({
  type: z.literal("volume"),
  db: z.number().min(-60).max(40).optional(),
  factor: z.number().gt(0).max(10).optional(),
});

/** Burn an .srt into the output during the single render pass.
 * CRITICAL: cue times are interpreted against the EDITED OUTPUT timeline —
 * generate source-timed srt through `video captions --plan` to remap. */
export const CaptionsOp = z.object({
  type: z.literal("captions"),
  file: z.string().min(1),
  /** ASS force_style, e.g. "FontSize=24,PrimaryColour=&HFFFFFF&" */
  style: z.string().optional(),
});

/** Sidechain ducking parameters — map 1:1 to sidechaincompress filter keys
 * (validated graph: docs/ultron/research/r1-audio-mix-single-pass.md). */
export const AudioMixDuck = z.object({
  /** LINEAR amplitude 0.000976563–1 (≈ −60…0 dB) — NOT dB, unlike every
   * other dB-flavored key in the schema. Default 0.02 (≈ −34 dB). */
  threshold: z.number().min(0.000976563).max(1).optional(),
  /** compression ratio; 1 = no ducking. Default 8 (~18 dB measured depth). */
  ratio: z.number().min(1).max(20).optional(),
  /** ms before ducking engages. Default 20. */
  attack: z.number().min(0.01).max(2000).optional(),
  /** ms before ducking releases. Default 400. */
  release: z.number().min(0.01).max(9000).optional(),
  /** post-compression gain (1–64); omitted → ffmpeg default (1). */
  makeup: z.number().min(1).max(64).optional(),
});

/** Mix a music bed under the plan's audio with speech-keyed sidechain
 * ducking — in the SAME single ffmpeg pass (INVARIANT 1). The bed loops
 * (`-stream_loop -1`) and is trimmed to the timeline; it conforms to the
 * speech stream's own sample rate/layout (no extra probes). */
export const AudioMixOp = z.object({
  type: z.literal("audio-mix"),
  /** music bed; any ffmpeg-decodable audio file (must exist). */
  file: z.string().min(1),
  /** bed gain in dB (−60…0; default −18). */
  level: z.number().min(-60).max(0).optional(),
  duck: AudioMixDuck.optional(),
});

/** Transform ops apply to the whole output; they never affect which source
 * ranges are kept (that stays the trim/cut pair). At most one of each. */
export type TransformOpType = "speed" | "resize" | "volume" | "captions" | "audio-mix";

export const Operation = z.discriminatedUnion("type", [
  TrimOp,
  CutOp,
  NormalizeAudioOp,
  SpeedOp,
  ResizeOp,
  VolumeOp,
  CaptionsOp,
  AudioMixOp,
]);

export const OutputSpec = z.object({
  path: z.string().min(1),
  mode: z.enum(["final", "preview"]).default("final"),
});

export const EditPlan = z.object({
  version: z.literal(1),
  source: z.string().min(1),
  operations: z.array(Operation).default([]),
  output: OutputSpec,
});

export type Operation = z.infer<typeof Operation>;
export type EditPlan = z.infer<typeof EditPlan>;
export type OutputSpec = z.infer<typeof OutputSpec>;

// ---- observation schemas (analysis workers emit these; render never reads them)

export const SilenceSegment = z.object({
  start: z.number(),
  end: z.number(),
  duration: z.number(),
});

export const SilenceReport = z.object({
  segments: z.array(SilenceSegment),
  duration: z.number().optional(),
  note: z.string().optional(),
  params: z.object({ thresholdDb: z.number(), minDurationSec: z.number() }).optional(),
});

export const SceneBoundary = z.object({
  timestamp: z.number(),
  confidence: z.number().min(0).max(1),
});
export const SceneReport = z.object({
  boundaries: z.array(SceneBoundary),
  duration: z.number().optional(),
  note: z.string().optional(),
  params: z.object({ threshold: z.number() }).optional(),
});

export const TranscriptSegment = z.object({
  start: z.number(),
  end: z.number(),
  text: z.string(),
});
export const TranscriptReport = z.object({
  segments: z.array(TranscriptSegment),
  duration: z.number().optional(),
  engine: z.string().optional(),
  model: z.string().optional(),
  language: z.string().optional(),
  note: z.string().optional(),
  params: z
    .object({
      chunkSeconds: z.number(),
      snapToSilence: z.boolean(),
      model: z.string().optional(),
    })
    .optional(),
});

export const FillerInstance = z.object({
  start: z.number(),
  end: z.number(),
  phrase: z.string(),
  context: z.string(),
});
export const FillerReport = z.object({
  instances: z.array(FillerInstance),
  duration: z.number().optional(),
  note: z.string().optional(),
  params: z.object({ phrases: z.array(z.string()) }).optional(),
});

export const HighlightCandidate = z.object({
  start: z.number(),
  end: z.number(),
  score: z.number().min(0).max(1),
  text: z.string(),
  reasons: z.array(z.string()),
});
export const HighlightReport = z.object({
  candidates: z.array(HighlightCandidate),
  duration: z.number().optional(),
  note: z.string().optional(),
  params: z
    .object({
      keywords: z.array(z.string()),
      minScore: z.number(),
      maxCount: z.number(),
    })
    .optional(),
});

/** Compact a ZodError into machine-readable issues with stable paths. */
export function schemaIssues(error: z.ZodError): {
  path: string;
  message: string;
  code: string;
}[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join(".") || "(root)",
    message: issue.message,
    code: issue.code,
  }));
}
