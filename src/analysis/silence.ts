import { runFFmpeg } from "../media/ffmpeg.js";
import { runAnalysis, round3, type AnalysisOpts } from "./runner.js";
import { SilenceReport } from "../core/schemas.js";
import type { z } from "zod";

export type SilenceReportData = z.infer<typeof SilenceReport>;

export interface SilenceParams {
  /** silence threshold in dB below average (default 35) */
  thresholdDb: number;
  /** minimum gap length in seconds to report (default 0.5) */
  minDurationSec: number;
}

const START_RE = /silence_start:\s*(-?[\d.]+)/;
const END_RE = /silence_end:\s*(-?[\d.]+)/;

/**
 * Parse silencedetect output. Events arrive in order (start, then end);
 * a trailing start with no end means silence ran to the end of the file.
 * Ported from vedit, where it was verified against known-content fixtures.
 */
export function parseSilenceOutput(
  stderr: string,
  sourceDuration: number,
): { start: number; end: number }[] {
  const starts: number[] = [];
  const ends: number[] = [];
  for (const line of stderr.split("\n")) {
    const s = START_RE.exec(line);
    if (s) starts.push(Math.max(0, Number(s[1])));
    const e = END_RE.exec(line);
    if (e) ends.push(Number(e[1]));
  }
  const pairs: { start: number; end: number }[] = [];
  for (const start of starts) {
    const next = ends[0];
    const end = next !== undefined && next >= start ? (ends.shift() as number) : sourceDuration;
    pairs.push({ start, end: Math.min(sourceDuration, end) });
  }
  return pairs;
}

export async function detectSilence(
  input: string,
  params: SilenceParams,
  opts: AnalysisOpts = {},
): Promise<SilenceReportData> {
  return runAnalysis<SilenceReportData>(
    input,
    {
      ...opts,
      cacheName: `silence-t${params.thresholdDb}-d${params.minDurationSec.toFixed(2)}.json`,
    },
    async ({ media }) => {
      if (!media.audio) {
        return { segments: [], duration: round3(media.duration), note: "no audio stream" };
      }
      const r = await runFFmpeg([
        "-nostdin", "-hide_banner",
        "-i", input,
        "-af", `silencedetect=noise=-${params.thresholdDb}dB:d=${params.minDurationSec}`,
        "-vn", "-f", "null", "-",
      ]);
      const raw = parseSilenceOutput(r.stderr, media.duration);
      const report: SilenceReportData = {
        segments: raw.map((p) => ({
          start: round3(p.start),
          end: round3(p.end),
          duration: round3(p.end - p.start),
        })),
        duration: round3(media.duration),
        params: { thresholdDb: params.thresholdDb, minDurationSec: params.minDurationSec },
      };
      return SilenceReport.parse(report);
    },
  );
}
