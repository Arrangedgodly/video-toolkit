import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runFFmpeg, buildTranscodeCommand, type EncoderId } from "../media/ffmpeg.js";
import { cachedInspect, Cache, type CacheOpts } from "../cache/cache.js";
import { diagnose } from "../hardware/diagnose.js";

export interface BenchmarkResult {
  encoder: EncoderId;
  concurrency: number;
  wallMs: number;
  sourceSeconds: number;
  realtimeMultiplier: number;
  fps: number;
  success: boolean;
  error?: string;
}

export interface BenchmarkReport {
  segmentSeconds: number;
  recommended: { encoder: EncoderId; renderConcurrency: number };
  results: BenchmarkResult[];
}

/** Measure which render strategy is actually fastest on this machine.
 * Renders a short representative segment per (encoder × concurrency) cell —
 * real renders, measured wall-clock, nothing inferred from RAM. */
export async function benchmarkInput(
  input: string,
  opts: CacheOpts & { seconds?: number } = {},
): Promise<BenchmarkReport> {
  const debug = opts.debug ?? (() => {});
  const media = await cachedInspect(input, opts);
  if (!media.video) {
    throw Object.assign(new Error("benchmark needs a video stream"), { code: "UNSUPPORTED_MEDIA" });
  }
  const segmentSeconds = Math.max(1, Math.min(opts.seconds ?? 6, media.duration, 30));

  const cache = new Cache();
  const id = await cache.sourceId(input);
  // benchmark results depend on the ffmpeg build, not just the source —
  // key the cache file by version so an upgrade invalidates it
  const { ffmpegVersion } = await import("../media/ffmpeg.js");
  const benchCache = `benchmark-${await ffmpegVersion("ffmpeg")}.json`;
  if (!opts.noCache) {
    const hit = await cache.read<BenchmarkReport>(id, benchCache);
    if (hit) {
      debug(`cache hit: ${benchCache} ${id}`);
      return hit;
    }
  }

  const diag = await diagnose();
  const strategies: EncoderId[] = ["libx264"];
  const hw = diag.ffmpeg.encoders.h264.hardware;
  if (hw === "h264_videotoolbox") strategies.push("h264_videotoolbox");
  const concurrencyLevels = [1, 2];

  const tmp = await mkdtemp(path.join(tmpdir(), "video-benchmark-"));
  const results: BenchmarkResult[] = [];
  try {
    for (const encoder of strategies) {
      for (const level of concurrencyLevels) {
        const jobs = Array.from({ length: level }, (_, i) => {
          const out = path.join(tmp, `${encoder}-c${level}-${i}.mp4`);
          const args = buildTranscodeCommand(input, out, encoder, segmentSeconds);
          return runFFmpeg(args).then(
            (r) => ({ frames: r.lastFrame, ok: true as const, err: "" }),
            (e: Error) => ({ frames: 0, ok: false as const, err: e.message }),
          );
        });
        const started = Date.now();
        const settled = await Promise.all(jobs);
        const wallMs = Date.now() - started;
        const frames = settled.reduce((acc, j) => acc + j.frames, 0);
        const success = settled.every((j) => j.ok);
        results.push({
          encoder,
          concurrency: level,
          wallMs,
          sourceSeconds: segmentSeconds * level,
          realtimeMultiplier: (segmentSeconds * level) / (wallMs / 1000),
          fps: frames / (wallMs / 1000),
          success,
          error: success ? undefined : settled.find((j) => !j.ok)?.err,
        });
        debug(`bench ${encoder} c${level}: ${wallMs}ms`);
      }
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  const ok = results.filter((r) => r.success);
  const best = ok.reduce((a, b) => (b.realtimeMultiplier > a.realtimeMultiplier ? b : a));
  const report: BenchmarkReport = {
    segmentSeconds,
    recommended: { encoder: best.encoder, renderConcurrency: best.concurrency },
    results,
  };
  if (!opts.noCache) await cache.write(id, benchCache, report);
  return report;
}
