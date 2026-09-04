import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fail } from "../core/errors.js";
import { TranscriptReport } from "../core/schemas.js";
import { compileTimeline } from "../core/timeline.js";
import { loadPlan } from "../validate/validate.js";
import { cachedInspect, type CacheOpts } from "../cache/cache.js";
import { formatSrt, mapCuesThroughTimeline, transcriptToCues } from "./srt.js";

export interface CaptionsResult {
  output: string;
  cues: number;
  dropped: number;
  remapped: boolean;
}

/**
 * Generate an .srt from a transcript. Without --plan, cue times equal the
 * transcript's source times. With --plan, cues are remapped through the
 * plan's compiled timeline so they line up with the edited output — a cue
 * spanning a cut splits; fragments under 0.3s drop.
 */
export async function generateCaptions(
  transcriptPath: string,
  opts: CacheOpts & { plan?: string; output?: string } = {},
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

  const output =
    opts.output ?? `${transcriptPath.replace(/\.[^.]+$/, "")}${remapped ? ".edited" : ""}.srt`;
  await writeFile(output, formatSrt(cues), "utf8");
  return { output: path.resolve(output), cues: cues.length, dropped, remapped };
}
