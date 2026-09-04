import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runFFmpeg } from "../../media/ffmpeg.js";
import { runAnalysis, round3, type AnalysisOpts } from "../runner.js";
import { TranscriptReport } from "../../core/schemas.js";
import { detectSilence } from "../silence.js";
import { planWindows } from "./windows.js";
import { resolveEngine } from "./engines.js";
import type { z } from "zod";

export type TranscriptReportData = z.infer<typeof TranscriptReport>;

export interface TranscribeOpts extends AnalysisOpts {
  engine?: string;
  model?: string;
  chunkSeconds?: number;
  /** snap window boundaries to nearby silence gaps (default true) */
  snapToSilence?: boolean;
}

function cacheSafe(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(-60);
}

/**
 * Transcribe any media file into timestamped segments. Audio is cut into
 * windows (snapped to silence), each window is transcoded to 16kHz mono WAV
 * and handed to the engine; segment times are exact because we made the cuts.
 * Cached per (source fingerprint, engine, model, chunk size).
 */
export async function transcribeInput(
  input: string,
  opts: TranscribeOpts = {},
): Promise<TranscriptReportData> {
  const engine = await resolveEngine(opts.engine);
  const chunk = opts.chunkSeconds ?? 25;
  const snap = opts.snapToSilence !== false;

  return runAnalysis<TranscriptReportData>(
    input,
    {
      ...opts,
      cacheName: `transcript-${engine.id}-${cacheSafe(opts.model ?? "default")}-c${chunk}.json`,
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
      debug(`transcribe: ${windows.length} window(s), chunk=${chunk}s, snap=${snap && silences.length > 0}`);

      const tmp = await mkdtemp(path.join(tmpdir(), "video-transcribe-"));
      const segments: { start: number; end: number; text: string }[] = [];
      let model = "unknown";
      let totalMs = 0;
      try {
        for (let i = 0; i < windows.length; i++) {
          const w = windows[i]!;
          const wav = path.join(tmp, `chunk_${String(i).padStart(4, "0")}.wav`);
          await runFFmpeg([
            "-nostdin", "-hide_banner", "-y",
            "-ss", w.start.toFixed(3), "-t", (w.end - w.start).toFixed(3),
            "-i", input,
            "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
            wav,
          ]);
          const r = await engine.transcribeWav(wav, { model: opts.model });
          model = r.model;
          totalMs += r.ms;
          const text = r.text.trim();
          debug(`window ${i + 1}/${windows.length} [${w.start.toFixed(1)}-${w.end.toFixed(1)}s]: ${text.slice(0, 60) || "(silence)"}`);
          if (text.length > 0) {
            segments.push({ start: round3(w.start), end: round3(w.end), text });
          }
        }
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }

      return TranscriptReport.parse({
        segments,
        duration: round3(media.duration),
        engine: engine.id,
        model,
        params: { chunkSeconds: chunk, snapToSilence: snap && silences.length > 0, model: opts.model },
        ...(totalMs > 0 ? { language: "auto" } : {}),
      });
    },
  );
}
