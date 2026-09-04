import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fail } from "../core/errors.js";
import { TranscriptReport } from "../core/schemas.js";
import { compileTimeline } from "../core/timeline.js";
import { loadPlan } from "../validate/validate.js";
import { cachedInspect, type CacheOpts } from "../cache/cache.js";
import { formatSrt, mapCuesThroughTimeline, transcriptToCues } from "./srt.js";
import { formatVtt } from "./vtt.js";

export type CaptionFormat = "srt" | "vtt";

export interface CaptionsResult {
  output: string;
  cues: number;
  dropped: number;
  remapped: boolean;
}

/**
 * Pure format selection: an explicit `--format srt|vtt` wins (and rescues any
 * output extension); otherwise the `-o` extension decides (`.srt`/`.vtt`,
 * case-insensitive; anything else is a machine-readable OUTPUT_PATH_INVALID);
 * with no `-o` the default is srt.
 */
export function resolveCaptionFormat(output?: string, format?: string): CaptionFormat {
  if (format !== undefined) {
    if (format !== "srt" && format !== "vtt") {
      fail("OPERATION_INVALID", `--format must be srt or vtt (got ${format})`, { format });
    }
    return format;
  }
  if (output !== undefined) {
    const lower = output.toLowerCase();
    if (lower.endsWith(".vtt")) return "vtt";
    if (lower.endsWith(".srt")) return "srt";
    fail("OUTPUT_PATH_INVALID", `captions output extension must be .srt or .vtt (or pass --format): ${output}`, {
      output,
    });
  }
  return "srt";
}

/**
 * Generate an .srt (default) or .vtt from a transcript. Without --plan, cue
 * times equal the transcript's source times. With --plan, cues are remapped
 * through the plan's compiled timeline so they line up with the edited
 * output — a cue spanning a cut splits; fragments under 0.3s drop. Cue math
 * is identical for both formats; only the serialization differs.
 */
export async function generateCaptions(
  transcriptPath: string,
  opts: CacheOpts & { plan?: string; output?: string; format?: string } = {},
): Promise<CaptionsResult> {
  let doc: unknown;
  try {
    const { readFile } = await import("node:fs/promises");
    doc = JSON.parse(await readFile(transcriptPath, "utf8"));
  } catch {
    fail("OBSERVATION_INVALID", `transcript file is missing or not valid JSON: ${transcriptPath}`);
  }
  const parsed = TranscriptReport.safeParse(doc);
  if (!parsed.success) {
    fail("OBSERVATION_INVALID", "file is not a valid transcript report", { file: transcriptPath });
  }

  const sourceCues = transcriptToCues(parsed.data);
  let cues = sourceCues;
  let dropped = 0;
  let remapped = false;

  if (opts.plan) {
    const plan = await loadPlan(opts.plan);
    const media = await cachedInspect(plan.source, opts);
    const timeline = compileTimeline(plan.operations, media.duration);
    const mapped = mapCuesThroughTimeline(sourceCues, timeline);
    const keptText = new Set(mapped.map((c) => c.text));
    dropped = sourceCues.filter((c) => !keptText.has(c.text)).length;
    cues = mapped;
    remapped = true;
  }

  const format = resolveCaptionFormat(opts.output, opts.format);
  const output =
    opts.output ?? `${transcriptPath.replace(/\.[^.]+$/, "")}${remapped ? ".edited" : ""}.${format}`;
  await writeFile(output, format === "vtt" ? formatVtt(cues) : formatSrt(cues), "utf8");
  return { output: path.resolve(output), cues: cues.length, dropped, remapped };
}
