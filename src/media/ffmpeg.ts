import { spawn } from "node:child_process";
import path from "node:path";
import { fail } from "../core/errors.js";
import { selectExpression, totalDuration, type Segment } from "../core/timeline.js";

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

/**
 * Build the single-pass render command for a compiled timeline.
 * All trims/cuts become one select filter over the source — no intermediate
 * renders, ever. (Recipe proven in vedit's test suite.) Transform ops
 * (speed/resize/volume) compose into the same single pass.
 */
export function buildRenderCommand(
  input: string,
  segments: Segment[],
  output: string,
  opts: RenderOptions,
  hasAudio: boolean,
): string[] {
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
    "format=yuv420p",
  ].join(",");

  const argv = ["-nostdin", "-hide_banner", "-y", "-i", input, "-vf", vf];

  if (hasAudio) {
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
