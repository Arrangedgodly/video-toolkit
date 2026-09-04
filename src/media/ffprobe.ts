import { spawn } from "node:child_process";
import { fail } from "../core/errors.js";

export interface VideoStreamInfo {
  codec: string;
  width: number;
  height: number;
  fps: number;
  bitrate: number;
  pixelFormat: string;
}

export interface AudioStreamInfo {
  codec: string;
  sampleRate: number;
  channels: number;
  bitrate: number;
}

export interface MediaInfo {
  file: string;
  duration: number;
  video?: VideoStreamInfo;
  audio?: AudioStreamInfo;
}

interface RawStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  pix_fmt?: string;
  sample_rate?: string;
  channels?: number;
  bit_rate?: string;
  duration?: string;
}

interface RawProbe {
  format?: { duration?: string; bit_rate?: string };
  streams?: RawStream[];
}

function parseFps(s: RawStream): number {
  for (const key of ["avg_frame_rate", "r_frame_rate"] as const) {
    const frac = s[key];
    if (!frac || frac === "0/0" || frac === "N/A") continue;
    const [num, den] = frac.split("/");
    const n = Number(num);
    const d = Number(den ?? 1);
    if (Number.isFinite(n) && Number.isFinite(d) && d !== 0 && n / d > 0) return n / d;
  }
  return 0;
}

export async function runCapture(
  command: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err) => {
      const code = (err as NodeJS.ErrnoException).code ?? "UNKNOWN";
      resolve({ code: -1, stdout, stderr: `${code}: failed to launch ${command}` });
    });
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

export function parseFfprobeJson(text: string): RawProbe {
  return JSON.parse(text) as RawProbe;
}

/** Convert raw ffprobe JSON into MediaInfo. Tolerates missing streams. */
export function toMediaInfo(file: string, raw: RawProbe): MediaInfo {
  const streams = raw.streams ?? [];
  const v = streams.find((s) => s.codec_type === "video");
  const a = streams.find((s) => s.codec_type === "audio");
  const duration = Number(raw.format?.duration ?? v?.duration ?? 0);
  const info: MediaInfo = { file, duration };
  if (v) {
    info.video = {
      codec: v.codec_name ?? "unknown",
      width: v.width ?? 0,
      height: v.height ?? 0,
      fps: Math.round(parseFps(v) * 1000) / 1000,
      bitrate: Number(v.bit_rate ?? raw.format?.bit_rate ?? 0),
      pixelFormat: v.pix_fmt ?? "unknown",
    };
  }
  if (a) {
    info.audio = {
      codec: a.codec_name ?? "unknown",
      sampleRate: Number(a.sample_rate ?? 0),
      channels: a.channels ?? 0,
      bitrate: Number(a.bit_rate ?? 0),
    };
  }
  if (!info.video && !info.audio) {
    fail("UNSUPPORTED_MEDIA", `no audio or video streams found in ${file}`);
  }
  return info;
}

export async function inspectFile(file: string): Promise<MediaInfo> {
  const r = await runCapture("ffprobe", [
    "-v", "error",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    "--", file,
  ]);
  if (r.code === -1 && r.stderr.startsWith("ENOENT")) {
    fail("FFPROBE_NOT_FOUND", "ffprobe binary not found on PATH");
  }
  if (r.code !== 0) {
    fail("UNSUPPORTED_MEDIA", `ffprobe could not read ${file}`, { stderr: r.stderr.slice(-400) });
  }
  return toMediaInfo(file, parseFfprobeJson(r.stdout));
}
