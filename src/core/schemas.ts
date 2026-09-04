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

/** Burn one text overlay (title card / lower third) during the single render
 * pass — ONE drawtext on the OUTPUT timeline (like captions). The text value
 * passes through TWO ffmpeg unescaping stages (filtergraph tokenizer, then
 * the option-value tokenizer), so it needs its own escaping helper
 * (escapeDrawText) — never reuse escapeFilterText for it. */
export const OverlayTextOp = z.object({
  type: z.literal("overlay-text"),
  /** literal text to burn; `%` is NOT special (expansion=none) */
  text: z.string().min(1).max(1024),
  /** visibility window on the OUTPUT timeline (s); both absent = always visible */
  from: z.number().min(0).optional(),
  to: z.number().min(0).optional(),
  /** vertical placement; default "bottom" */
  position: z.enum(["top", "center", "bottom"]).optional(),
  /** font size in output px; default 48 */
  fontsize: z.number().int().gt(0).max(512).optional(),
  /** ffmpeg color name or 0xRRGGBB[AA]; default "white". Filter-syntax
   * characters are rejected by the shape so the value can never need
   * escaping. */
  color: z
    .string()
    .max(64)
    .regex(
      /^(?:0x[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?|[A-Za-z][A-Za-z0-9_]*)$/,
      "must be 0xRRGGBB[AA] hex or an alphanumeric color name",
    )
    .optional(),
  /** semi-transparent backing box; default true */
  box: z.boolean().optional(),
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

/** Crossfade transition kind — a FROZEN allowlist drawn from this build's
 * `ffmpeg -h filter=xfade` enum (all verified present on ffmpeg 9.0.1
 * ffmpeg-full; T13's live-parsed catalog must remain a superset). `fade` is
 * the only empirically validated kind (docs/ultron/research/
 * r3-xfade-single-pass.md); every kind shares the same duration/offset
 * semantics. */
export const CROSSFADE_KINDS = [
  "fade",
  "fadeblack",
  "fadewhite",
  "wipeleft",
  "wiperight",
  "wipeup",
  "wipedown",
  "slideleft",
  "slideright",
  "slideup",
  "slidedown",
  "dissolve",
  "circleopen",
  "circleclose",
  "radial",
] as const;

/** Join consecutive keep-segments with crossfade transitions (video `xfade` +
 * audio `acrossfade`), still in ONE ffmpeg pass (INVARIANT 1 — R3's validated
 * chain). TIMELINE-affecting: output duration = timeline − (N−1)·duration.
 * Client-side bounds are load-bearing — ffmpeg silently corrupts when the
 * fade reaches a segment length or drops below one frame. */
export const CrossfadeOp = z.object({
  type: z.literal("crossfade"),
  /** fade duration per join, seconds (> 0; validate enforces the real
   * floor: ≥ 0.05 s and ≥ one source frame, and < EVERY keep-segment) */
  duration: z.number().gt(0).max(60),
  /** xfade transition name; default "fade" */
  kind: z.enum(CROSSFADE_KINDS).default("fade"),
});

/** Transform ops apply to the whole output; they never affect which source
 * ranges are kept (that stays the trim/cut pair). At most one of each. */
export type TransformOpType =
  | "speed"
  | "resize"
  | "volume"
  | "captions"
  | "overlay-text"
  | "audio-mix";

export const Operation = z.discriminatedUnion("type", [
  TrimOp,
  CutOp,
  NormalizeAudioOp,
  SpeedOp,
  ResizeOp,
  VolumeOp,
  CaptionsOp,
  OverlayTextOp,
  AudioMixOp,
  CrossfadeOp,
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

export const WordTiming = z.object({
  start: z.number(),
  end: z.number(),
  text: z.string(),
});
export const TranscriptSegment = z.object({
  start: z.number(),
  end: z.number(),
  text: z.string(),
  /** per-word timings (seconds, 3 decimals); present only when the engine
   * produced them (whisper-cpp `--word-timestamps`) — consumers must treat
   * absence as "segment granularity only" */
  words: z.array(WordTiming).optional(),
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
      chunkSeconds: z.number().optional(),
      snapToSilence: z.boolean().optional(),
      model: z.string().optional(),
      /** native-segment engines (no windowing) record the words flag here */
      wordTimestamps: z.boolean().optional(),
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
  params: z
    .object({
      phrases: z.array(z.string()),
      /** which timing source produced the instance times: exact per-word
       * anchors ("words", from segments[].words) vs linear interpolation
       * within each segment ("segments"). Optional so pre-T11 filler
       * reports (params without precision) still parse. */
      precision: z.enum(["words", "segments"]).optional(),
    })
    .optional(),
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
