import { readFile } from "node:fs/promises";
import { fail } from "./errors.js";
import { HighlightReport, SilenceReport } from "./schemas.js";
import { silenceToCuts } from "../analysis/silence-to-cuts.js";
import { highlightsToTrims } from "../analysis/highlights-to-trims.js";
import { cachedInspect, type CacheOpts } from "../cache/cache.js";

export interface ScaffoldOpts extends CacheOpts {
  cutsFrom?: string;
  minDuration?: number;
  pad?: number;
  highlightsFrom?: string;
  count?: number;
  minScore?: number;
}

/** Scaffold a valid whole-source plan, optionally expanding an observation
 * into operations via a deterministic bridge: silence → cuts, highlights →
 * top-N trims (a compilation). Shared by the CLI and the MCP server. */
export async function scaffoldPlanObject(
  input: string,
  opts: ScaffoldOpts = {},
): Promise<{
  version: 1;
  source: string;
  operations: unknown[];
  output: { path: string; mode: "final" };
}> {
  const media = await cachedInspect(input, opts);
  const stem = input.replace(/\.[^.]+$/, "");
  const duration = Math.round(media.duration * 1000) / 1000;
  const operations: unknown[] = [{ type: "trim", start: 0, end: duration }];

  if (opts.cutsFrom && opts.highlightsFrom) {
    fail(
      "OPERATION_INVALID",
      "plan accepts one bridge per invocation: --cuts-from or --highlights-from, not both",
    );
  }

  if (opts.cutsFrom) {
    let doc: unknown;
    try {
      doc = JSON.parse(await readFile(opts.cutsFrom, "utf8"));
    } catch {
      fail("OBSERVATION_INVALID", `observation file is missing or not valid JSON: ${opts.cutsFrom}`);
    }
    const parsed = SilenceReport.safeParse(doc);
    if (!parsed.success) {
      fail("OBSERVATION_INVALID", "file is not a valid silence report", { file: opts.cutsFrom });
    }
    operations.push(
      ...silenceToCuts(parsed.data, media.duration, {
        minDuration: opts.minDuration ?? 0.5,
        pad: opts.pad ?? 0.25,
      }),
    );
  }

  if (opts.highlightsFrom) {
    let doc: unknown;
    try {
      doc = JSON.parse(await readFile(opts.highlightsFrom, "utf8"));
    } catch {
      fail("OBSERVATION_INVALID", `observation file is missing or not valid JSON: ${opts.highlightsFrom}`);
    }
    const parsed = HighlightReport.safeParse(doc);
    if (!parsed.success) {
      fail("OBSERVATION_INVALID", "file is not a valid highlight report", { file: opts.highlightsFrom });
    }
    const trims = highlightsToTrims(parsed.data, media.duration, {
      count: opts.count ?? 5,
      minScore: opts.minScore ?? 0.35,
      pad: opts.pad ?? 0.5,
    });
    if (trims.length > 0) {
      // a compilation keeps only the highlights — the whole-source trim
      // is replaced, not supplemented. No qualifying candidate: the
      // whole-source scaffold stands.
      operations.length = 0;
      operations.push(...trims);
    }
  }

  return {
    version: 1,
    source: input,
    operations,
    output: { path: `${stem}_edited.mp4`, mode: "final" },
  };
}
