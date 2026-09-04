import os from "node:os";
import { binaryPath, ffmpegVersion, listEncoders, listHwaccels } from "../media/ffmpeg.js";

export interface EncoderCapability {
  software: string | null;
  hardware: string | null;
}

export interface Diagnosis {
  os: { platform: string; release: string; arch: string };
  cpu: { model: string; logicalCores: number };
  memory: { totalMb: number; freeMb: number };
  binaries: {
    ffmpeg: { version: string; path: string | null };
    ffprobe: { version: string; path: string | null };
  };
  ffmpeg: {
    hwaccels: string[];
    encoders: Record<"h264" | "hevc" | "av1", EncoderCapability>;
  };
}

function pick(entries: { name: string; codec: string; hardware: boolean }[], codec: string): EncoderCapability {
  const forCodec = entries.filter((e) => e.codec === codec);
  return {
    software: forCodec.find((e) => !e.hardware)?.name ?? null,
    hardware: forCodec.find((e) => e.hardware)?.name ?? null,
  };
}

/** Detect the environment and ffmpeg capabilities. No vendor assumptions —
 * hardware encoders are discovered from ffmpeg's own encoder listing, so
 * videotoolbox / nvenc / qsv / amf all fall out of the same query. */
export async function diagnose(): Promise<Diagnosis> {
  const [encoders, hwaccels, ffmpegVer, ffprobeVer, ffmpegPath, ffprobePath] =
    await Promise.all([
      listEncoders(),
      listHwaccels(),
      ffmpegVersion("ffmpeg"),
      ffmpegVersion("ffprobe"),
      binaryPath("ffmpeg"),
      binaryPath("ffprobe"),
    ]);

  const cpus = os.cpus();
  return {
    os: { platform: os.platform(), release: os.release(), arch: os.arch() },
    cpu: { model: cpus[0]?.model ?? "unknown", logicalCores: cpus.length },
    memory: {
      totalMb: Math.round(os.totalmem() / 1024 / 1024),
      freeMb: Math.round(os.freemem() / 1024 / 1024),
    },
    binaries: {
      ffmpeg: { version: ffmpegVer, path: ffmpegPath },
      ffprobe: { version: ffprobeVer, path: ffprobePath },
    },
    ffmpeg: {
      hwaccels,
      encoders: {
        h264: pick(encoders, "h264"),
        hevc: pick(encoders, "hevc"),
        av1: pick(encoders, "av1"),
      },
    },
  };
}
