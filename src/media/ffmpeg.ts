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
  /** when set, append the single-pass GIF palette graph (plan op
   * `export-gif`): the from/to OUTPUT-timeline window, then the recipe
   * proven in vedit's build_gif (vedit.py:363-375) — fps → lanczos scale →
   * split/palettegen(diff)/paletteuse(bayer:bayer_scale=5) INSIDE the one
   * `-filter_complex` (the two-pass palette workflow would break INVARIANT 1
   * and is never used). Audio is dropped (-an); h264/movflags are omitted
   * (gif muxer). */
  gif?: GifExportOptions;
  /** when set, Ken Burns camera motion rides the SAME single pass (plan op
   * `zoom`; graph validated in docs/ultron/research/r5-zoom-motion.md):
   * select path — one zoompan over the re-timed stream, between `select`
   * and the retime `setpts` (zoompan DISCARDS input PTS, so speed must come
   * after); chain path — one zoompan per input before the xfade links (ALL
   * inputs uniformly — mixed zoompan/plain inputs fail loudly). Duration
   * invariance is frame-exact: d=1 + fps=source + s=source WxH. */
  zoom?: ZoomOptions;
}

/** Terminal export op `export-gif` (defaults applied by the render layer). */
export interface GifExportOptions {
  /** output width px; height keeps aspect (-2 = even) */
  width: number;
  /** output fps */
  fps: number;
  /** window start on the OUTPUT timeline (s); undefined = from the start */
  from?: number;
  /** window end on the OUTPUT timeline (s); undefined = to the end */
  to?: number;
}

export type ZoomMode = "in" | "out" | "left" | "right" | "up" | "down";
export type ZoomEasing = "smooth" | "linear";

/** Ken Burns motion (plan op `zoom`; defaults applied by the render layer).
 * The source facts (fps/W/H) ride the same object — already-probed media
 * info, never a new probe (R5's implementation consequence #4). */
export interface ZoomOptions {
  /** CAMERA direction; `in`/`out` = center-anchored zoom, pans = constant
   * zoom with a full-range traverse */
  mode: ZoomMode;
  /** zoom level, 1.0 < f ≤ 2.0 (validated at plan time) */
  factor: number;
  easing: ZoomEasing;
  /** probed source fps — passed to zoompan VERBATIM (never its 25 default:
   * a wrong fps silently re-times the output) */
  srcFps: number;
  /** probed source width (px) — zoompan `s=` and the pan prescale */
  srcWidth: number;
  /** probed source height (px) */
  srcHeight: number;
}

/** Ramp frame count for one motion unit (R5): N = max(2, round(dur×fps)).
 * Select path: one unit = the whole timeline; chain path: one unit PER
 * keep-segment. The max(2,…) floor keeps `on/(N−1)` evaluable; validate
 * rejects the sub-2-frame units that would actually reach it. */
export function zoomRampFrames(durationSeconds: number, fps: number): number {
  return Math.max(2, Math.round(durationSeconds * fps));
}

/** The absolute `on`-frame z/x/y expressions for one motion unit (R5's
 * binding table, pure functions of F, N, on). p = min(on/(N−1),1) absorbs
 * the select path's inclusive-`between` +1 frame per segment (the ramp
 * holds at its end value for the ≤2 trailing frames); easing e(p) = p
 * (linear) or 3p²−2p³ (smooth). ABSOLUTE ONLY: the classic incremental
 * `zoom+step` recipe is a measured silent NO-OP with d=1 on this build and
 * `pzoom+step` runs away — never emit either. */
export function zoomExpressions(
  mode: ZoomMode,
  factor: number,
  easing: ZoomEasing,
  rampFrames: number,
): { z: string; x: string; y: string } {
  const last = Math.max(1, rampFrames - 1);
  const p = `min(on/${last},1)`;
  const e = easing === "linear" ? p : `${p}*${p}*(3-2*${p})`;
  const f = trimNum(factor);
  const range = trimNum(factor - 1);
  const cx = "iw/2-(iw/zoom/2)";
  const cy = "ih/2-(ih/zoom/2)";
  switch (mode) {
    case "in":
      return { z: `1+${range}*${e}`, x: cx, y: cy };
    case "out":
      return { z: `1+${range}*(1-${e})`, x: cx, y: cy };
    case "right":
      return { z: f, x: `(iw-iw/zoom)*${e}`, y: cy };
    case "left":
      return { z: f, x: `(iw-iw/zoom)*(1-${e})`, y: cy };
    case "down":
      return { z: f, x: cx, y: `(ih-ih/zoom)*${e}` };
    case "up":
      return { z: f, x: cx, y: `(ih-ih/zoom)*(1-${e})` };
  }
}

function isPanMode(mode: ZoomMode): boolean {
  return mode === "left" || mode === "right" || mode === "up" || mode === "down";
}

/** One zoompan chain link (R5's committed discipline): `d=1` (one output
 * frame per input frame — NEVER the 90 default, ×108 duration blowup),
 * `fps=<probed source fps>` (NOT the 25 default — silent re-time),
 * `s=<source WxH>` (NOT the hd720 default — silent resize). PAN modes get a
 * ×2 prescale first (native-res pans stall/jump on the integer crop origin:
 * half the frames frozen; the prescale hands the scaler sub-pixel steps).
 * Inside zoompan `iw`/`ih` are the filter's INPUT frame (the prescaled one),
 * so the expressions are coordinate-system-agnostic by construction. */
export function zoomPanFilter(zoom: ZoomOptions, rampFrames: number): string {
  const { z, x, y } = zoomExpressions(zoom.mode, zoom.factor, zoom.easing, rampFrames);
  return (
    (isPanMode(zoom.mode)
      ? `scale=${zoom.srcWidth * 2}:${zoom.srcHeight * 2},`
      : "") +
    `zoompan=z='${z}':x='${x}':y='${y}':d=1:fps=${trimNum(zoom.srcFps)}` +
    `:s=${zoom.srcWidth}x${zoom.srcHeight}`
  );
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

/** The single-pass GIF palette suffix (recipe proven verbatim in vedit's
 * build_gif, vedit.py:363-375 — never a separate palette pass): the
 * from/to OUTPUT-timeline window (trim + renorm, BEFORE fps so the window
 * selects retimed frames), then `fps=N,scale=W:-2:flags=lanczos` feeding
 * `split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=
 * dither=bayer:bayer_scale=5` — bayer dither is ordered/deterministic.
 * Emits `…[v]`; append with `,` to a chain (or feed a labeled stream). */
function gifPaletteChain(gif: GifExportOptions): string {
  const t3 = (n: number) => n.toFixed(3);
  const window: string[] = [];
  if (gif.from !== undefined || gif.to !== undefined) {
    const bounds: string[] = [];
    if (gif.from !== undefined) bounds.push(`start=${t3(gif.from)}`);
    if (gif.to !== undefined) bounds.push(`end=${t3(gif.to)}`);
    window.push(`trim=${bounds.join(":")}`, "setpts=PTS-STARTPTS");
  }
  const chain = [
    ...window,
    `fps=${trimNum(gif.fps)}`,
    `scale=${gif.width}:-2:flags=lanczos`,
  ].join(",");
  return (
    `${chain},split[a][b];` +
    "[a]palettegen=stats_mode=diff[p];" +
    "[b][p]paletteuse=dither=bayer:bayer_scale=5[v]"
  );
}

/** Single-pass transition composition (R3, validated verbatim at N=2/3/5:
 * docs/ultron/research/r3-xfade-single-pass.md). Video: chained xfade with
 * offsets O_k = Σ_{i≤k} L_i − k·D; the LAST link carries the tail chain
 * (speed → scale → subtitles → overlay → format — the same order as the
 * -vf path, but `setpts=PTS/s` because the chain already emits clean CFR
 * from 0). Audio (only when the source has audio): chained acrossfade, d=D
 * per join, tail [atempo][loudnorm][volume] on the last link. One
 * invocation, N inputs of the SAME source (INVARIANT 1: inputs only).
 * With `opts.gif` the last link ends at [vx] and the palette suffix rides
 * after it (audio chain omitted, `-an`). */
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
    // yuv420p is the h264/mp4 contract — the gif palette path must not be
    // forced into it before palettegen
    ...(opts.gif ? [] : ["format=yuv420p"]),
  ];

  const links: string[] = [];
  // zoom rides per-input BEFORE the xfade links — every input uniformly (R5
  // F2b: zoompan on only SOME inputs fails loudly, exit 234 timebase
  // mismatch). Each input gets its own ramp N_k = max(2, round(L_k·fps)) —
  // the per-clip Ken Burns treatment: motion re-runs its full ramp per
  // segment and resets at each join (the fade itself carries the reset).
  if (opts.zoom) {
    for (let k = 0; k < n; k++) {
      const len = segments[k]!.end - segments[k]!.start;
      links.push(`[${k}:v]${zoomPanFilter(opts.zoom, zoomRampFrames(len, opts.zoom.srcFps))}[z${k}]`);
    }
  }
  for (let k = 1; k < n; k++) {
    const left = k === 1 ? (opts.zoom ? "z0" : "0:v") : `v${k - 1}`;
    const right = opts.zoom ? `z${k}` : `${k}:v`;
    const last = k === n - 1;
    const chain =
      `xfade=transition=${crossfade.kind}:duration=${d}:offset=${t3(offsets[k - 1]!)}` +
      (last && videoTail.length > 0 ? `,${videoTail.join(",")}` : "");
    links.push(`[${left}][${right}]${chain}[${last ? (opts.gif ? "vx" : "v") : `v${k}`}]`);
  }
  if (opts.gif) {
    links.push(`[vx]${gifPaletteChain(opts.gif)}`);
  }
  if (hasAudio && !opts.gif) {
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
  if (opts.gif) {
    argv.push("-an", output); // gif muxer: no audio, no h264/mov flags
    return argv;
  }
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
 * `opts.gif` appends the palette graph after the composed video chain and
 * muxes to the gif muxer (`-map [v] -an`, no h264/mov flags) — the select
 * path moves into -filter_complex for it, still exactly one invocation.
 * `opts.zoom` inserts a zoompan between `select` and the retime `setpts`
 * (select path / gif select path) or per-input before the xfade links
 * (chain path) — still exactly one invocation, duration frame-exact (R5).
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
  // one continuous ramp across the WHOLE program (R5: N = max(2,
  // round(timelineDuration × fps)), unscaled — speed re-times AFTER zoompan;
  // the min(·,1) clamp absorbs the inclusive-`between` +1 frame per segment)
  const zoomLink = opts.zoom
    ? [zoomPanFilter(opts.zoom, zoomRampFrames(totalDuration(segments), opts.zoom.srcFps))]
    : [];

  if (opts.gif) {
    // render-path enforcement of the extension contract (validate also
    // checks; this is the builder's own guard, the crossfade-refusal pattern)
    if (!output.toLowerCase().endsWith(".gif")) {
      fail("OUTPUT_PATH_INVALID", `export-gif: output path must end in .gif (got ${output})`);
    }
    if (opts.mix) {
      // GIF carries no audio — the bed would be a silently dropped no-op
      fail(
        "OPERATION_INVALID",
        "export-gif + audio-mix in one plan is not a supported composition (GIF carries no audio)",
      );
    }
    const head = [
      `select='${expr}'`,
      ...zoomLink,
      `setpts=N/FRAME_RATE/TB${speed ? `/${trimNum(speed)}` : ""}`,
      ...(opts.scaleWidth ? [`scale=${opts.scaleWidth}:${opts.scaleHeight ?? -2}`] : []),
      ...(opts.subtitleFile
        ? [
            `subtitles=filename=${escapeFilterPath(opts.subtitleFile)}` +
              (opts.subtitleStyle ? `:force_style='${escapeFilterText(opts.subtitleStyle)}'` : ""),
          ]
        : []),
      ...(opts.overlayText ? [drawTextFilter(opts.overlayText)] : []),
      // no format=yuv420p: the palette graph owns the pixel format
    ];
    const graph = `[0:v]${[...head, gifPaletteChain(opts.gif)].join(",")}`;
    return [
      "-nostdin", "-hide_banner", "-y",
      "-i", input,
      "-filter_complex", graph,
      "-map", "[v]",
      "-an",
      output,
    ];
  }

  const vf = [
    `select='${expr}'`,
    ...zoomLink,
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
