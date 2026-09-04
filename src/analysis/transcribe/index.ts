import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runFFmpeg, ffmpegVersion } from "../../media/ffmpeg.js";
import { runAnalysis, round3, type AnalysisOpts } from "../runner.js";
import { Cache } from "../../cache/cache.js";
import { TranscriptReport } from "../../core/schemas.js";
import { fail } from "../../core/errors.js";
import { detectSilence } from "../silence.js";
import { planWindows } from "./windows.js";
import { ENGINES, resolveEngine } from "./engines.js";
import type { z } from "zod";

export type TranscriptReportData = z.infer<typeof TranscriptReport>;

export interface TranscribeOpts extends AnalysisOpts {
  engine?: string;
  model?: string;
  chunkSeconds?: number;
  /** snap window boundaries to nearby silence gaps (default true) */
  snapToSilence?: boolean;
  /** max windows processed in parallel (each window = one WAV extraction +
   * one independent engine process). Default: the cached `video benchmark`
   * recommendation for this source when present, else 1 (conservative —
   * every engine invocation loads its own model). Not part of the cache
   * key: the report is byte-identical to sequential. No-op for native-
   * segment engines (one whole-file invocation). */
  concurrency?: number;
  /** request per-word timestamps; selects a word-capable engine (implicit
   * engine = whisper-cpp when no --engine is given). Part of the cache
   * key for native-segment engines: toggling the flag misses a warm cache. */
  wordTimestamps?: boolean;
}

function cacheSafe(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(-60);
}

/** Deterministic bounded-parallel map. Results are index-aligned (source
 * order) regardless of completion order; scheduling stops at the first
 * failure and the LOWEST-INDEX failure is thrown, so error semantics match
 * the sequential path. Exported for unit tests. */
export async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const width = Math.max(1, Math.min(Math.floor(limit), items.length));
  const results = new Array<R>(items.length);
  let next = 0;
  let failedIndex = Number.POSITIVE_INFINITY;
  let failedErr: unknown;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (failedIndex !== Number.POSITIVE_INFINITY) return; // stop scheduling
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i]!, i);
      } catch (err) {
        if (i < failedIndex) {
          failedIndex = i;
          failedErr = err;
        }
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: width }, () => worker()));
  if (failedIndex !== Number.POSITIVE_INFINITY) throw failedErr;
  return results;
}

/** Engine-safe default parallelism from a parsed benchmark report: its
 * measured `recommended.renderConcurrency` when sane, else 1. Pure —
 * unit-tested directly. */
export function concurrencyFromBenchmark(bench: unknown): number {
  const n = (bench as { recommended?: { renderConcurrency?: unknown } } | null)
    ?.recommended?.renderConcurrency;
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 4 ? n : 1;
}

/** Default = measured benchmark recommendation for THIS source + ffmpeg
 * build (same cache file `video benchmark` writes), else conservative 1. */
async function defaultConcurrency(input: string): Promise<number> {
  try {
    const cache = new Cache();
    const id = await cache.sourceId(input);
    const bench = await cache.read(id, `benchmark-${await ffmpegVersion("ffmpeg")}.json`);
    return concurrencyFromBenchmark(bench);
  } catch {
    return 1;
  }
}

/**
 * Transcribe any media file into timestamped segments. Native-segment engines
 * (whisper-cpp) are honored with ONE whole-file 16kHz mono WAV invocation —
 * no windowing, no silence snap (--chunk/--concurrency are no-ops), segments
 * and optional per-word times come from the engine itself. Whole-text engines
 * (handy) are cut into windows (snapped to silence), each transcoded to
 * 16kHz mono WAV and stamped with its exact time range; windows run with
 * bounded parallelism and the report is byte-identical to the sequential
 * path. Cached per (source fingerprint, engine, model, chunk size [+ words
 * flag for native engines]) — concurrency is deliberately NOT in the key.
 */
export async function transcribeInput(
  input: string,
  opts: TranscribeOpts = {},
): Promise<TranscriptReportData> {
  if (
    opts.concurrency !== undefined &&
    (!Number.isInteger(opts.concurrency) || opts.concurrency < 1)
  ) {
    fail("OPERATION_INVALID", "--concurrency must be an integer >= 1", {
      concurrency: opts.concurrency,
    });
  }
  if (opts.wordTimestamps) {
    // param guard BEFORE any engine work: an explicit word-incapable engine
    // (no transcribeSegments) can never satisfy --word-timestamps
    const explicit = opts.engine ? ENGINES.find((e) => e.id === opts.engine) : undefined;
    if (explicit && !explicit.transcribeSegments) {
      fail("OPERATION_INVALID", `--word-timestamps requires a word-capable engine; '${explicit.id}' emits whole-file text only`, {
        engine: explicit.id,
        known: ENGINES.filter((e) => e.transcribeSegments).map((e) => e.id),
      });
    }
  }
  const engine = await resolveEngine(
    opts.wordTimestamps && !opts.engine ? "whisper-cpp" : opts.engine,
  );
  const chunk = opts.chunkSeconds ?? 25;
  const snap = opts.snapToSilence !== false;

  // native-segment engines: c0 = no chunking (the windowed path always keys
  // its real chunk value, >= 2 in practice), w<0|1> = the words flag — so the
  // two families can never collide and toggling words misses the warm cache
  const cacheName = engine.transcribeSegments
    ? `transcript-${engine.id}-${cacheSafe(opts.model ?? "default")}-c0-w${opts.wordTimestamps ? 1 : 0}.json`
    : `transcript-${engine.id}-${cacheSafe(opts.model ?? "default")}-c${chunk}.json`;

  if (engine.transcribeSegments) {
    return runAnalysis<TranscriptReportData>(
      input,
      { ...opts, cacheName },
      async ({ media }) => {
        if (!media.audio || media.duration <= 0) {
          return TranscriptReport.parse({
            segments: [],
            duration: round3(media.duration),
            engine: engine.id,
            note: "no audio stream",
          });
        }
        const debug = opts.debug ?? (() => {});
        debug(`transcribe: ${engine.id} native segments, whole-file (no windows), words=${opts.wordTimestamps === true}`);
        const tmp = await mkdtemp(path.join(tmpdir(), "video-transcribe-"));
        try {
          const wav = path.join(tmp, "full.wav");
          await runFFmpeg([
            "-nostdin", "-hide_banner", "-y",
            "-i", input,
            "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
            wav,
          ]);
          const r = await engine.transcribeSegments!(wav, {
            model: opts.model,
            words: opts.wordTimestamps,
            durationSecs: media.duration,
          });
          const wordCount = r.segments.reduce((n, s) => n + (s.words?.length ?? 0), 0);
          debug(
            `whisper: ${r.segments.length} segment(s), ${wordCount} word(s): ${r.segments.map((s) => s.text).join(" ").slice(0, 60)}`,
          );
          return TranscriptReport.parse({
            segments: r.segments,
            duration: round3(media.duration),
            engine: engine.id,
            model: r.model,
            ...(r.language ? { language: r.language } : {}),
            params: { model: opts.model, wordTimestamps: opts.wordTimestamps === true },
          });
        } finally {
          await rm(tmp, { recursive: true, force: true });
        }
      },
    );
  }

  return runAnalysis<TranscriptReportData>(
    input,
    {
      ...opts,
      cacheName,
    },
    async ({ media }) => {
      if (!media.audio || media.duration <= 0) {
        return TranscriptReport.parse({
          segments: [],
          duration: round3(media.duration),
          engine: engine.id,
          note: "no audio stream",
        });
      }

      const debug = opts.debug ?? (() => {});
      const silences =
        snap && media.duration > chunk
          ? (
              await detectSilence(input, { thresholdDb: 40, minDurationSec: 0.3 }, opts)
            ).segments.map((s) => ({ start: s.start, end: s.end }))
          : [];
      const windows = planWindows(media.duration, chunk, silences);
      const concurrency = opts.concurrency ?? (await defaultConcurrency(input));
      debug(
        `transcribe: ${windows.length} window(s), chunk=${chunk}s, snap=${snap && silences.length > 0}, concurrency=${concurrency}`,
      );

      const tmp = await mkdtemp(path.join(tmpdir(), "video-transcribe-"));
      try {
        // each job = one WAV extraction + one independent engine process;
        // per-window WAV names are unique by index, so jobs never collide
        const results = await mapBounded(
          windows,
          concurrency,
          async (w, i) => {
            const wav = path.join(tmp, `chunk_${String(i).padStart(4, "0")}.wav`);
            await runFFmpeg([
              "-nostdin", "-hide_banner", "-y",
              "-ss", w.start.toFixed(3), "-t", (w.end - w.start).toFixed(3),
              "-i", input,
              "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
              wav,
            ]);
            const r = await engine.transcribeWav(wav, { model: opts.model });
            const text = r.text.trim();
            debug(
              `window ${i + 1}/${windows.length} [${w.start.toFixed(1)}-${w.end.toFixed(1)}s]: ${text.slice(0, 60) || "(silence)"}`,
            );
            return r;
          },
        );

        // reassemble in window order: completion order cannot leak into the
        // report (windows are non-overlapping and ascending, so sorting by
        // start is a total, deterministic order)
        const segments: { start: number; end: number; text: string }[] = [];
        let model = "unknown";
        let totalMs = 0;
        for (let i = 0; i < windows.length; i++) {
          const w = windows[i]!;
          const r = results[i]!;
          model = r.model;
          totalMs += r.ms;
          const text = r.text.trim();
          if (text.length > 0) {
            segments.push({ start: round3(w.start), end: round3(w.end), text });
          }
        }
        segments.sort((a, b) => a.start - b.start);

        return TranscriptReport.parse({
          segments,
          duration: round3(media.duration),
          engine: engine.id,
          model,
          params: { chunkSeconds: chunk, snapToSilence: snap && silences.length > 0, model: opts.model },
          ...(totalMs > 0 ? { language: "auto" } : {}),
        });
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    },
  );
}
