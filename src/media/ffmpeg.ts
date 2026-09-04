import { spawn } from "node:child_process";
import path from "node:path";
import { fail } from "../core/errors.js";
import { selectExpression, totalDuration, xfadeOffsets, type Segment } from "../core/timeline.js";

export type EncoderId = "libx264" | "h264_videotoolbox";

/** Escape a path for ffmpeg's filter-graph parser: these characters are
 * filter syntax. Proven in vedit's captions tests. */
export function escapeFilterPath(p: string): string {
  let s = path.resolve(p).replace(/\\/g, "\\\\");
  for (const ch of ["'", ":", ",", "[", "]", ";"]) {
    s = s.split(ch).join("\\" + ch);
  }
  return s;
}

export function escapeFilterText(s: string): string {
  let out = s.replace(/\\/g, "\\\\");
  for (const ch of ["'", ":", ",", "[", "]", ";"]) {
    out = out.split(ch).join("\\" + ch);
  }
  return out;
}

/** Fixed overlay-text font — a documented machine fact (AGENTS.md
 * ENVIRONMENT FACTS): present and rendering via this build's freetype.
 * Missing file → OPERATION_INVALID at validate time. */
export const OVERLAY_FONT_FILE = "/System/Library/Fonts/Helvetica.ttc";

/** Escape literal text for drawtext's `text=` value. Unlike other filter
 * values, drawtext text crosses TWO unescaping stages — the filtergraph
 * tokenizer (`\x`→x, quotes spliced) and then the option-value tokenizer
 * (same rules again, `:`-separated) — so backslash prefixes must survive one
 * collapse: `\`→4 backslashes, `'`→3, `:`→2, filter separators `,;[]`→1
 * (they are only special at stage 1). `%` is passed through raw because the
 * builder always sets expansion=none. Empirically verified on this ffmpeg
 * build: renders pixel-identical to a textfile= ground truth for the full
 * hostile set (`:` `'` `%` `\` `,` `;` `[` `]`). */
export function escapeDrawText(s: string): string {
  let out = s.replace(/\\/g, "\\\\\\\\"); // 1 backslash -> 4
  out = out.replace(/'/g, "\\\\\\'"); // ' -> 3 backslashes + '
  out = out.replace(/:/g, "\\\\:"); // : -> 2 backslashes + :
  out = out.replace(/([,;[\]])/g, "\\$1"); // separators -> 1 backslash
  return out;
}

export interface RenderOptions {
  encoder: EncoderId;
  /** software path (libx264) */
  crf: number;
  preset: string;
  /** hardware path (h264_videotoolbox) */
  videoBitrate: string;
  audioBitrate: string;
  /** downscale width for previews (keeps aspect); undefined = full size */
  scaleWidth?: number;
  /** exact output height when the resize op specifies one; width-only otherwise */
  scaleHeight?: number;
  /** when set, append single-pass loudnorm at this LUFS target */
  normalizeLufs: number | null;
  /** global playback speed factor */
  speedFactor?: number;
  /** global audio gain in dB */
  volumeDb?: number | null;
  /** burn this .srt during the same pass (output-timeline cue times) */
  subtitleFile?: string;
  subtitleStyle?: string;
  /** burn one text overlay (drawtext) during the same pass — OUTPUT-timeline
   * window like captions, after scale/subtitles so fontsize is in output px */
  overlayText?: OverlayTextOptions;
  /** when set (and the source has audio), mix a music bed under the program
   * audio with speech-keyed sidechain ducking — still one ffmpeg pass
   * (graph validated in docs/ultron/research/r1-audio-mix-single-pass.md) */
  mix?: MixOptions | null;
  /** when set, join the keep-segments with crossfade transitions instead of
   * hard cuts: N `-ss/-t -i <source>` inputs + chained xfade/acrossfade in
   * ONE invocation (graph validated in docs/ultron/research/
   * r3-xfade-single-pass.md). Requires ≥2 segments and
   * duration < every segment length (validate enforces both). */
  crossfade?: CrossfadeOptions;
}

/** One crossfade transition declaration (plan op `crossfade`). Offsets are
 * computed in the UNSCALED timeline; speed/scale/subtitles/overlay compose
 * AFTER the chain (R3's composition findings). */
export interface CrossfadeOptions {
  /** fade duration per join (s) */
  duration: number;
  /** xfade transition name (schema-frozen allowlist; default "fade") */
  kind: string;
}

/** One burned text overlay (plan op `overlay-text`; defaults applied by the
 * render layer). Times are OUTPUT-timeline seconds; the enable window gates
 * the drawtext on the same retimed frames captions burn into. */
export interface OverlayTextOptions {
  text: string;
  /** visibility window start (s); undefined = from the first frame */
  from?: number;
  /** visibility window end (s); undefined = to the last frame */
  to?: number;
  position: "top" | "center" | "bottom";
  /** output px */
  fontsize: number;
  /** ffmpeg color spec (schema-validated: hex or alphanumeric name) */
  color: string;
  /** semi-transparent backing box (box=1:boxcolor=black@0.5:boxborderw=12) */
  box: boolean;
}

export interface MixDuckOptions {
  /** sidechaincompress threshold — LINEAR amplitude, NOT dB */
  threshold: number;
  ratio: number;
  /** ms */
  attack: number;
  /** ms */
  release: number;
  /** optional post-compression gain; undefined → filter default (1) */
  makeup?: number;
}

export interface MixOptions {
  /** music bed; added as `-stream_loop -1 -i <bedFile>` (loops, then atrim) */
  bedFile: string;
  /** bed gain in dB applied before ducking */
  levelDb: number;
  duck: MixDuckOptions;
  /** atrim bound for the looped bed = expected output duration (timeline /
   * speed); a determinism bound, not a hang fix */
  bedTrimSeconds: number;
  /** speech stream's own sample rate — the BED conforms to the SPEECH */
  speechSampleRate: number;
  /** speech channel layout ("mono"|"stereo"|…); undefined = negotiate */
  speechLayout?: string;
}

/** ffmpeg channel-layout name for a channel count (speech-side conform
 * target for the mix bed); undefined leaves layout negotiation to ffmpeg. */
export function channelLayoutFor(channels: number): string | undefined {
  switch (channels) {
    case 1: return "mono";
    case 2: return "stereo";
    case 3: return "2.1";
    case 4: return "quad";
    case 5: return "5.0";
    case 6: return "5.1";
    case 7: return "6.1";
    case 8: return "7.1";
    default: return undefined;
  }
}

/** atempo is valid per-instance in [0.5, 2.0]; chain instances for any factor.
 * (Recipe proven in vedit's test suite.) */
export function atempoChain(factor: number): string {
  let f = factor;
  const pieces: number[] = [];
  while (f > 2 + 1e-9) {
    pieces.push(2);
    f /= 2;
  }
  while (f < 0.5 - 1e-9) {
    pieces.push(0.5);
    f /= 0.5;
  }
  if (Math.abs(f - 1) > 1e-6 || pieces.length === 0) pieces.push(f);
  return pieces.map((p) => `atempo=${trimNum(p)}`).join(",");
}

function trimNum(n: number): string {
  return String(Math.round(n * 10000) / 10000);
}

/** Duck params keep up to 9 decimals: threshold's minimum (2^-10 =
 * 0.000976563) must survive formatting untouched. */
function preciseNum(n: number): string {
  return String(Math.round(n * 1e9) / 1e9);
}

/** Single-pass sidechain-ducking audio graph (validated verbatim in
 * docs/ultron/research/r1-audio-mix-single-pass.md, run A):
 * speech selects/retimes like the -af path, then splits into sidechain key
 * + program; the bed loops, conforms to the speech's own rate/layout, takes
 * its level, and ducks against the key; amix keeps the speech native
 * (normalize=0) and ends at the speech EOF (duration=first). Global
 * transforms (loudnorm, volume) act on the final program, after the mix. */
function buildMixFilterGraph(
  expr: string,
  mix: MixOptions,
  opts: RenderOptions,
  speed?: number,
): string {
  const speech = [
    `aselect='${expr}'`,
    "asetpts=N/SR/TB",
    ...(speed ? [atempoChain(speed)] : []),
    ...(mix.speechLayout ? [`aformat=channel_layouts=${mix.speechLayout}`] : []),
  ].join(",");
  const bed = [
    `aformat=sample_fmts=fltp:sample_rates=${mix.speechSampleRate}` +
      (mix.speechLayout ? `:channel_layouts=${mix.speechLayout}` : ""),
    `volume=${trimNum(mix.levelDb)}dB`,
    "asetpts=N/SR/TB",
    `atrim=duration=${trimNum(mix.bedTrimSeconds)}`,
  ].join(",");
  const sidechain =
    `sidechaincompress=threshold=${preciseNum(mix.duck.threshold)}` +
    `:ratio=${preciseNum(mix.duck.ratio)}` +
    `:attack=${preciseNum(mix.duck.attack)}` +
    `:release=${preciseNum(mix.duck.release)}` +
    (mix.duck.makeup !== undefined ? `:makeup=${preciseNum(mix.duck.makeup)}` : "");
  const tail = [
    ...(opts.normalizeLufs !== null
      ? [`loudnorm=I=${opts.normalizeLufs}:TP=-1.5:LRA=11`]
      : []),
    ...(opts.volumeDb !== null && opts.volumeDb !== undefined
      ? [`volume=${trimNum(opts.volumeDb)}dB`]
      : []),
  ];
  return (
    `[0:a]${speech}[speech];` +
    `[speech]asplit=2[sc][main];` +
    `[1:a]${bed}[bed];` +
    `[bed][sc]${sidechain}[ducked];` +
    `[main][ducked]amix=inputs=2:duration=first:normalize=0` +
    (tail.length > 0 ? `,${tail.join(",")}` : "") +
    "[a]"
  );
}

/** ONE drawtext filter for the overlay-text op. Deterministic placement:
 * x centered, y per position with fixed 10%-of-height margins. Omitted
 * window bounds are unbounded (gte/lte); both present = between. Times at
 * 3 decimals like every emitted timestamp. */
function drawTextFilter(o: OverlayTextOptions): string {
  const y =
    o.position === "top"
      ? "h*0.1"
      : o.position === "center"
        ? "(h-text_h)/2"
        : "h-text_h-h*0.1";
  const parts = [
    `fontfile=${escapeFilterPath(OVERLAY_FONT_FILE)}`,
    `text=${escapeDrawText(o.text)}`,
    `fontsize=${o.fontsize}`,
    `fontcolor=${o.color}`,
    "x=(w-text_w)/2",
    `y=${y}`,
  ];
  if (o.box) parts.push("box=1", "boxcolor=black@0.5", "boxborderw=12");
  // part of the escaping contract: `%` stays literal in the text
  parts.push("expansion=none");
  const window =
    o.from !== undefined && o.to !== undefined
      ? `between(t,${o.from.toFixed(3)},${o.to.toFixed(3)})`
      : o.from !== undefined
        ? `gte(t,${o.from.toFixed(3)})`
        : o.to !== undefined
          ? `lte(t,${o.to.toFixed(3)})`
          : undefined;
  if (window) parts.push(`enable='${window}'`);
  return `drawtext=${parts.join(":")}`;
}

/** Single-pass transition composition (R3, validated verbatim at N=2/3/5:
 * docs/ultron/research/r3-xfade-single-pass.md). Video: chained xfade with
 * offsets O_k = Σ_{i≤k} L_i − k·D; the LAST link carries the tail chain
 * (speed → scale → subtitles → overlay → format — the same order as the
 * -vf path, but `setpts=PTS/s` because the chain already emits clean CFR
 * from 0). Audio (only when the source has audio): chained acrossfade, d=D
 * per join, tail [atempo][loudnorm][volume] on the last link. One
 * invocation, N inputs of the SAME source (INVARIANT 1: inputs only). */
function buildTransitionCommand(
  input: string,
  segments: Segment[],
  output: string,
  opts: RenderOptions,
  hasAudio: boolean,
  crossfade: CrossfadeOptions,
): string[] {
  if (opts.mix) {
    // validated combinations only — validate.ts rejects this plan; the
    // builder refuses rather than silently dropping the bed
    fail(
      "OPERATION_INVALID",
      "crossfade + audio-mix in one plan is not a supported composition",
    );
  }
  const speed = opts.speedFactor && opts.speedFactor !== 1 ? opts.speedFactor : undefined;
  const t3 = (n: number) => n.toFixed(3);
  const d = t3(crossfade.duration);
  const offsets = xfadeOffsets(segments, crossfade.duration);
  const n = segments.length;

  const videoTail = [
    ...(speed ? [`setpts=PTS/${trimNum(speed)}`] : []),
    ...(opts.scaleWidth ? [`scale=${opts.scaleWidth}:${opts.scaleHeight ?? -2}`] : []),
    ...(opts.subtitleFile
      ? [
          `subtitles=filename=${escapeFilterPath(opts.subtitleFile)}` +
            (opts.subtitleStyle ? `:force_style='${escapeFilterText(opts.subtitleStyle)}'` : ""),
        ]
      : []),
    ...(opts.overlayText ? [drawTextFilter(opts.overlayText)] : []),
    "format=yuv420p",
  ];

  const links: string[] = [];
  for (let k = 1; k < n; k++) {
    const left = k === 1 ? "0:v" : `v${k - 1}`;
    const last = k === n - 1;
    const chain =
      `xfade=transition=${crossfade.kind}:duration=${d}:offset=${t3(offsets[k - 1]!)}` +
      (last && videoTail.length > 0 ? `,${videoTail.join(",")}` : "");
    links.push(`[${left}][${k}:v]${chain}[${last ? "v" : `v${k}`}]`);
  }
  if (hasAudio) {
    const audioTail = [
      ...(speed ? [atempoChain(speed)] : []),
      ...(opts.normalizeLufs !== null
        ? [`loudnorm=I=${opts.normalizeLufs}:TP=-1.5:LRA=11`]
        : []),
      ...(opts.volumeDb !== null && opts.volumeDb !== undefined
        ? [`volume=${trimNum(opts.volumeDb)}dB`]
        : []),
    ];
    for (let k = 1; k < n; k++) {
      const left = k === 1 ? "0:a" : `a${k - 1}`;
      const last = k === n - 1;
      const chain =
        `acrossfade=d=${d}` +
        (last && audioTail.length > 0 ? `,${audioTail.join(",")}` : "");
      links.push(`[${left}][${k}:a]${chain}[${last ? "a" : `a${k}`}]`);
    }
  }

  const argv = ["-nostdin", "-hide_banner", "-y"];
  for (const seg of segments) {
    argv.push("-ss", t3(seg.start), "-t", t3(seg.end - seg.start), "-i", input);
  }
  argv.push("-filter_complex", links.join(";"));
  argv.push("-map", "[v]");
  if (hasAudio) {
    argv.push("-map", "[a]", "-c:a", "aac", "-b:a", opts.audioBitrate);
  } else {
    argv.push("-an");
  }
  if (opts.encoder === "libx264") {
    argv.push("-c:v", "libx264", "-crf", String(opts.crf), "-preset", opts.preset);
  } else {
    argv.push("-c:v", "h264_videotoolbox", "-b:v", opts.videoBitrate, "-realtime", "0");
  }
  argv.push("-movflags", "+faststart", output);
  return argv;
}

/**
 * Build the single-pass render command for a compiled timeline.
 * All trims/cuts become one select filter over the source — no intermediate
 * renders, ever. (Recipe proven in vedit's test suite.) Transform ops
 * (speed/resize/volume) compose into the same single pass; `opts.mix` moves
 * the audio chain into -filter_complex (sidechain ducking + amix) while the
 * video -vf chain stays untouched — still exactly one ffmpeg invocation.
 * `opts.crossfade` (with ≥2 segments) swaps the select composition for the
 * transition chain (N inputs + xfade/acrossfade) — also one invocation.
 */
export function buildRenderCommand(
  input: string,
  segments: Segment[],
  output: string,
  opts: RenderOptions,
  hasAudio: boolean,
): string[] {
  if (opts.crossfade) {
    if (segments.length < 2) {
      // validate rejects this before render; never a silent no-op
      fail(
        "OPERATION_INVALID",
        `crossfade needs at least 2 keep-segments (got ${segments.length})`,
      );
    }
    return buildTransitionCommand(input, segments, output, opts, hasAudio, opts.crossfade);
  }
  const expr = selectExpression(segments);
  const speed = opts.speedFactor && opts.speedFactor !== 1 ? opts.speedFactor : undefined;
  const vf = [
    `select='${expr}'`,
    `setpts=N/FRAME_RATE/TB${speed ? `/${trimNum(speed)}` : ""}`,
    ...(opts.scaleWidth ? [`scale=${opts.scaleWidth}:${opts.scaleHeight ?? -2}`] : []),
    ...(opts.subtitleFile
      ? [
          `subtitles=filename=${escapeFilterPath(opts.subtitleFile)}` +
            (opts.subtitleStyle ? `:force_style='${escapeFilterText(opts.subtitleStyle)}'` : ""),
        ]
      : []),
    ...(opts.overlayText ? [drawTextFilter(opts.overlayText)] : []),
    "format=yuv420p",
  ].join(",");

  // audio-mix without an audio stream is a silent no-op (validated as a
  // NO_AUDIO_STREAM warning) — never add the bed input or graph then
  const mix = hasAudio && opts.mix ? opts.mix : undefined;

  const argv = ["-nostdin", "-hide_banner", "-y", "-i", input];
  if (mix) argv.push("-stream_loop", "-1", "-i", mix.bedFile);
  argv.push("-vf", vf);

  if (mix) {
    // audio moves into -filter_complex; termination is NATURAL (no -shortest,
    // no -t): video ends at the last kept frame, audio at amix's first input
    argv.push(
      "-filter_complex", buildMixFilterGraph(expr, mix, opts, speed),
      "-map", "0:v", "-map", "[a]",
      "-c:a", "aac", "-b:a", opts.audioBitrate,
    );
  } else if (hasAudio) {
    const af = [
      `aselect='${expr}'`,
      "asetpts=N/SR/TB",
      ...(speed ? [atempoChain(speed)] : []),
      ...(opts.normalizeLufs !== null
        ? [`loudnorm=I=${opts.normalizeLufs}:TP=-1.5:LRA=11`]
        : []),
      ...(opts.volumeDb !== null && opts.volumeDb !== undefined
        ? [`volume=${trimNum(opts.volumeDb)}dB`]
        : []),
    ].join(",");
    argv.push("-af", af, "-c:a", "aac", "-b:a", opts.audioBitrate);
  } else {
    argv.push("-an");
  }

  if (opts.encoder === "libx264") {
    argv.push("-c:v", "libx264", "-crf", String(opts.crf), "-preset", opts.preset);
  } else {
    argv.push("-c:v", "h264_videotoolbox", "-b:v", opts.videoBitrate, "-realtime", "0");
  }

  argv.push("-movflags", "+faststart", output);
  return argv;
}

/** Plain transcode of the first `limitSeconds` — benchmark workload only. */
export function buildTranscodeCommand(
  input: string,
  output: string,
  encoder: EncoderId,
  limitSeconds: number,
): string[] {
  const argv = ["-nostdin", "-hide_banner", "-y", "-t", String(limitSeconds), "-i", input];
  if (encoder === "libx264") {
    argv.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "23");
  } else {
    argv.push("-c:v", "h264_videotoolbox", "-b:v", "8M", "-realtime", "0");
  }
  argv.push("-an", output);
  return argv;
}

export interface FFmpegRunResult {
  command: string[];
  exitCode: number;
  durationMs: number;
  /** full stderr — required by analysis parsers (silencedetect, metadata=print) */
  stderr: string;
  stderrTail: string;
  lastFrame: number;
  lastTimeSec: number;
}

const TIME_RE = /time=(\d+):(\d+):([\d.]+)/;
const FRAME_RE = /frame=\s*(\d+)/g;

/** Spawn ffmpeg with an argv array (never a shell string), parse progress,
 * and normalize failures into ToolError with the command + stderr tail. */
export async function runFFmpeg(
  args: string[],
  opts: { onProgress?: (p: { percent: number | null; timeSec: number }) => void; expectedDuration?: number } = {},
): Promise<FFmpegRunResult> {
  const started = Date.now();
  return new Promise<FFmpegRunResult>((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let lastFrame = 0;
    let lastTimeSec = 0;

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      const m = TIME_RE.exec(text);
      if (m) {
        const h = Number(m[1]);
        const min = Number(m[2]);
        const s = Number(m[3]);
        if (Number.isFinite(h) && Number.isFinite(min) && Number.isFinite(s)) {
          lastTimeSec = h * 3600 + min * 60 + s;
          const frames = [...text.matchAll(FRAME_RE)];
          if (frames.length > 0) {
            lastFrame = Number(frames[frames.length - 1]?.[1] ?? lastFrame);
          }
          opts.onProgress?.({
            timeSec: lastTimeSec,
            percent: opts.expectedDuration
              ? Math.min(100, (lastTimeSec / opts.expectedDuration) * 100)
              : null,
          });
        }
      }
    });

    child.on("error", (err) => {
      const code = (err as NodeJS.ErrnoException).code ?? "UNKNOWN";
      if (code === "ENOENT") {
        fail("FFMPEG_NOT_FOUND", "ffmpeg binary not found on PATH");
      }
      reject(err);
    });

    child.on("close", (code) => {
      const result: FFmpegRunResult = {
        command: ["ffmpeg", ...args],
        exitCode: code ?? -1,
        durationMs: Date.now() - started,
        stderr,
        stderrTail: stderr.trim().split("\n").slice(-15).join("\n"),
        lastFrame,
        lastTimeSec,
      };
      if (result.exitCode === 0) resolve(result);
      else {
        fail("FFMPEG_FAILED", `ffmpeg exited with code ${result.exitCode}`, {
          command: result.command.join(" "),
          stderrTail: result.stderrTail,
        });
      }
    });
  });
}

// ---- capability queries (used by diagnose + benchmark)

export interface EncoderEntry {
  name: string;
  codec: string;
  hardware: boolean;
}

export async function listEncoders(): Promise<EncoderEntry[]> {
  const { runCapture } = await import("./ffprobe.js");
  const r = await runCapture("ffmpeg", ["-hide_banner", "-encoders"]);
  const entries: EncoderEntry[] = [];
  for (const line of r.stdout.split("\n").slice(10)) {
    const m = /^\s(\S{6})\s+(\S+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const name = m[2] ?? "";
    const desc = m[3] ?? "";
    const codec = /\((?:codec )([^)]+)\)/.exec(desc)?.[1] ?? "";
    const hardware = /videotoolbox|nvenc|qsv|amf|vaapi|mediafoundation/.test(name);
    entries.push({ name, codec, hardware });
  }
  return entries;
}

export async function listHwaccels(): Promise<string[]> {
  const { runCapture } = await import("./ffprobe.js");
  const r = await runCapture("ffmpeg", ["-hide_banner", "-hwaccels"]);
  return r.stdout
    .split("\n")
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("Hardware"));
}

export async function ffmpegVersion(binary: "ffmpeg" | "ffprobe"): Promise<string> {
  const { runCapture } = await import("./ffprobe.js");
  const r = await runCapture(binary, ["-hide_banner", "-version"]);
  const m = /version\s+(\S+)/.exec(r.stdout);
  return m?.[1] ?? "unknown";
}

let _filterCache: Set<string> | null = null;

/** Does this ffmpeg build have a given filter (e.g. "subtitles" needs libass)? */
export async function hasFilter(name: string): Promise<boolean> {
  if (_filterCache === null) {
    const { runCapture } = await import("./ffprobe.js");
    const r = await runCapture("ffmpeg", ["-hide_banner", "-filters"]);
    _filterCache = new Set(
      r.stdout
        .split("\n")
        .slice(4)
        .map((l) => l.trim().split(/\s+/)[1] ?? "")
        .filter(Boolean),
    );
  }
  return _filterCache.has(name);
}

export async function binaryPath(binary: string): Promise<string | null> {
  const { runCapture } = await import("./ffprobe.js");
  const r = await runCapture("which", [binary]);
  return r.code === 0 ? r.stdout.trim() : null;
}

/** Expected output duration for progress math. */
export function expectedOutputDuration(segments: Segment[]): number {
  return totalDuration(segments);
}
