import { fail } from "../core/errors.js";
import { runFFmpeg } from "../media/ffmpeg.js";
import { runAnalysis, round3, type AnalysisOpts } from "./runner.js";
import { LoudnessReport } from "../core/schemas.js";
import type { z } from "zod";

export type LoudnessReportData = z.infer<typeof LoudnessReport>;

/** loudnorm first-pass targets — FIXED to the normalize-audio render path's
 * own defaults (I=-16, TP=-1.5, LRA=11) so the measurement describes exactly
 * what a `normalize-audio` op would act on. The input_* values loudnorm
 * reports do not depend on these; they are recorded (params.targetI) and
 * cache-keyed for reproducibility. */
export const LOUDNORM_TARGET_I = -16;
export const LOUDNORM_TP = -1.5;
export const LOUDNORM_LRA = 11;

export interface LoudnessMeasurement {
  inputI: number;
  inputTP: number;
  inputLRA: number;
  inputThresh: number;
}

const FIELDS: [keyof LoudnessMeasurement, string][] = [
  ["inputI", "input_i"],
  ["inputTP", "input_tp"],
  ["inputLRA", "input_lra"],
  ["inputThresh", "input_thresh"],
];

/** loudnorm emits its values as STRINGS ("-9.05"); digital silence comes
 * through as the literal "-inf", which Number() cannot parse — map it (and
 * its variants) to ±Infinity explicitly. */
function fieldValue(block: Record<string, unknown>, jsonKey: string): number {
  const raw = block[jsonKey];
  if (typeof raw === "number") return raw;
  if (typeof raw !== "string") return Number.NaN;
  if (/^[+-]?inf(inity)?$/i.test(raw.trim())) {
    return raw.trim().startsWith("-") ? -Infinity : Infinity;
  }
  return Number(raw);
}

/**
 * Extract loudnorm's measurement JSON from a first-pass run's stderr. The
 * block (print_format=json) arrives at the END of otherwise-noisy stderr —
 * banner, stream dumps, progress — as a `{`…`}`-delimited object with
 * loudnorm's values as STRINGS ("-9.05"). The LAST parsable block carrying
 * an input_i key wins; the four input_* fields must all be present and
 * numeric (a missing/garbled block is an ffmpeg-output contract break →
 * FFMPEG_FAILED). ±Infinity values ("−inf": loudnorm on digital silence)
 * are passed through — the worker turns them into an empty report + note.
 * Pure + deterministic: same stderr in, same measurement out.
 */
export function parseLoudnormJson(stderr: string): LoudnessMeasurement {
  const lines = stderr.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]!.trim().startsWith("{")) continue;
    for (let j = i; j < lines.length; j++) {
      if (lines[j]!.trim() !== "}") continue;
      let block: Record<string, unknown>;
      try {
        block = JSON.parse(lines.slice(i, j + 1).join("\n")) as Record<string, unknown>;
      } catch {
        break; // this `{`…`}` span is not JSON — keep scanning earlier blocks
      }
      if (!("input_i" in block)) break; // a JSON object, but not loudnorm's
      const m = {} as LoudnessMeasurement;
      for (const [key, jsonKey] of FIELDS) {
        const value = fieldValue(block, jsonKey);
        if (Number.isNaN(value)) {
          fail("FFMPEG_FAILED", `loudnorm emitted a non-numeric ${jsonKey}: ${JSON.stringify(block[jsonKey])}`);
        }
        m[key] = value;
      }
      return m;
    }
  }
  fail("FFMPEG_FAILED", "loudnorm measurement JSON not found on stderr (print_format=json)", {
    stderrTail: stderr.trim().split("\n").slice(-15).join("\n"),
  });
}

/**
 * Measure the source's loudness (loudnorm first pass) as a cached
 * observation. Writes NO media file — the analysis invocation muxes to
 * `-f null -`, so this is a probe (benchmark's measurement invocations are
 * the precedent), not a render. The deterministic input for
 * `normalize-audio` targeting: gain to reach a target LUFS = target −
 * inputI (dB), or set normalize-audio.target directly.
 */
export async function measureLoudness(
  input: string,
  opts: AnalysisOpts = {},
): Promise<LoudnessReportData> {
  return runAnalysis<LoudnessReportData>(
    input,
    { ...opts, cacheName: `loudness-i${LOUDNORM_TARGET_I}.json` },
    async ({ media }) => {
      if (!media.audio) {
        return { duration: round3(media.duration), note: "no audio stream" };
      }
      const r = await runFFmpeg([
        "-nostdin", "-hide_banner",
        "-i", input,
        "-af", `loudnorm=I=${LOUDNORM_TARGET_I}:TP=${LOUDNORM_TP}:LRA=${LOUDNORM_LRA}:print_format=json`,
        "-vn", "-f", "null", "-",
      ]);
      const m = parseLoudnormJson(r.stderr);
      if (!Number.isFinite(m.inputI) || !Number.isFinite(m.inputTP)) {
        // loudnorm reports -inf on (near-)digital silence — nothing to target
        return { duration: round3(media.duration), note: "audio measures as silence (loudnorm: -inf)" };
      }
      return LoudnessReport.parse({
        inputI: m.inputI,
        inputTP: m.inputTP,
        inputLRA: m.inputLRA,
        inputThresh: m.inputThresh,
        duration: round3(media.duration),
        params: { targetI: LOUDNORM_TARGET_I },
      });
    },
  );
}
