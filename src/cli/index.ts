#!/usr/bin/env node
import { cachedInspect } from "../cache/cache.js";
import { ToolError } from "../core/errors.js";
import { scaffoldPlanObject } from "../core/scaffold.js";
import type { EncoderId } from "../media/ffmpeg.js";
import { renderPlan } from "../render/render.js";
import { validatePlan } from "../validate/validate.js";
import { diagnose } from "../hardware/diagnose.js";
import { benchmarkInput } from "../benchmark/benchmark.js";
import { detectSilence } from "../analysis/silence.js";
import { detectScenes } from "../analysis/scenes.js";
import { extractFrames } from "../analysis/frames.js";
import { reviewFrames } from "../analysis/review-frames.js";
import { generateProxy } from "../analysis/proxy.js";
import { transcribeInput } from "../analysis/transcribe/index.js";
import { detectFillerInstances, DEFAULT_FILLER_PHRASES } from "../analysis/filler.js";
import { scoreHighlights, DEFAULT_HIGHLIGHT_PARAMS } from "../analysis/highlights.js";
import { generateCaptions } from "../captions/generate.js";
import { SceneReport, SilenceReport, TranscriptReport } from "../core/schemas.js";

const USAGE = `video — agent-native video editing toolkit

usage: video <command> [args] [flags]

commands:
  inspect <input>            structured media metadata (JSON)
  plan <input>               scaffold a valid edit plan for the source (JSON)
  validate <plan>            check a plan; machine-readable errors (JSON)
  preview <plan>             cheap preview render (<output>.preview.mp4)
  render <plan>              final render from the validated plan
  diagnose                   environment + ffmpeg capabilities (JSON)
  benchmark <input>          measure fastest encoder/concurrency on this machine

analysis (timestamped observations; never render):
  detect-silence <input>     silence gaps [--threshold dB] [--min-duration s]
  detect-scenes <input>      scene-cut boundaries [--threshold 0..1]
  transcribe <input>         timestamped transcript [--engine handy] [--model ID]
                             [--chunk s] [--no-snap (silence boundary snapping)]
                             [--concurrency N (parallel windows; default 1 or
                             the cached benchmark recommendation)]
  detect-filler <transcript.json>  filler-word candidates [--words "um,uh,..."]
  find-highlights <input>    highlight proposals from --transcript t.json
                             [--keywords "a,b,c"] [--min-score 0.35] [--count 5]
  captions <transcript.json>  transcript -> .srt [--plan p.json] remaps cue times
                             through the plan's cuts
  extract-frame <input>      jpg stills [--at t1,t2] [--count N] [--size W]
  review-frames <input>      grouped stills around scene boundaries
                             --scenes scenes.json [--per-boundary N=4]
                             [--window s=1.5] [--size W=480] [--dir D]
  generate-proxy <input>     low-cost review copy [--width W] [--output F]

agent adapter:
  mcp                       MCP stdio server (JSON-RPC tools for MCP clients)

plan operations: trim (keep range), cut (remove range), normalize-audio,
  speed (factor), resize (width[, height]), volume (db|factor),
  audio-mix (file, level dB, duck{threshold LINEAR, ratio, attack ms, release ms});
  transform ops are global — at most one of each per plan.

flags: --pretty  --debug  --no-cache  --force(render)  --encoder <libx264|h264_videotoolbox>
       --mode <final|preview>(render)  --seconds N(benchmark)
       plan: --cuts-from <silence.json|filler.json> (one bridge per invocation;
             silence: [--min-duration s=0.5] [--pad s=0.25];
             filler: [--filler-pad-before s=0.10] [--filler-pad-end s=0.25])
             or --highlights-from <highlights.json>
             [--count N=5] [--min-score 0.35] [--pad s=0.5]`;

interface CliFlags {
  positional: string[];
  pretty: boolean;
  debug: boolean;
  noCache: boolean;
  force: boolean;
  encoder?: EncoderId;
  mode?: "final" | "preview";
  seconds?: number;
  threshold?: number;
  minDuration?: number;
  pad?: number;
  at?: string;
  count?: number;
  size?: number;
  dir?: string;
  scenes?: string;
  perBoundary?: number;
  window?: number;
  width?: number;
  output?: string;
  cutsFrom?: string;
  fillerPadBefore?: number;
  fillerPadEnd?: number;
  highlightsFrom?: string;
  engine?: string;
  model?: string;
  chunk?: number;
  concurrency?: number;
  noSnap?: boolean;
  words?: string;
  transcript?: string;
  keywords?: string;
  minScore?: number;
  plan?: string;
}

function parseArgs(argv: string[]): CliFlags {
  const f: CliFlags = {
    positional: [],
    pretty: false,
    debug: false,
    noCache: false,
    force: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--pretty") f.pretty = true;
    else if (a === "--debug") f.debug = true;
    else if (a === "--no-cache") f.noCache = true;
    else if (a === "--force") f.force = true;
    else if (a === "--encoder") f.encoder = argv[++i] as EncoderId;
    else if (a === "--mode") f.mode = argv[++i] as "final" | "preview";
    else if (a === "--seconds") f.seconds = Number(argv[++i]);
    else if (a === "--threshold") f.threshold = Number(argv[++i]);
    else if (a === "--min-duration") f.minDuration = Number(argv[++i]);
    else if (a === "--pad") f.pad = Number(argv[++i]);
    else if (a === "--at") f.at = argv[++i];
    else if (a === "--count") f.count = Number(argv[++i]);
    else if (a === "--size") f.size = Number(argv[++i]);
    else if (a === "--dir") f.dir = argv[++i];
    else if (a === "--scenes") f.scenes = argv[++i];
    else if (a === "--per-boundary") f.perBoundary = Number(argv[++i]);
    else if (a === "--window") f.window = Number(argv[++i]);
    else if (a === "--width") f.width = Number(argv[++i]);
    else if (a === "--output" || a === "-o") f.output = argv[++i];
    else if (a === "--cuts-from") f.cutsFrom = argv[++i];
    else if (a === "--filler-pad-before") f.fillerPadBefore = Number(argv[++i]);
    else if (a === "--filler-pad-end") f.fillerPadEnd = Number(argv[++i]);
    else if (a === "--highlights-from") f.highlightsFrom = argv[++i];
    else if (a === "--engine") f.engine = argv[++i];
    else if (a === "--model") f.model = argv[++i];
    else if (a === "--chunk") f.chunk = Number(argv[++i]);
    else if (a === "--concurrency") f.concurrency = Number(argv[++i]);
    else if (a === "--no-snap") f.noSnap = true;
    else if (a === "--words") f.words = argv[++i];
    else if (a === "--transcript") f.transcript = argv[++i];
    else if (a === "--keywords") f.keywords = argv[++i];
    else if (a === "--min-score") f.minScore = Number(argv[++i]);
    else if (a === "--plan") f.plan = argv[++i];
    else if (a === "-h" || a === "--help") f.positional.push("__help__");
    else f.positional.push(a);
  }
  return f;
}

function emit(f: CliFlags, data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, f.pretty ? 2 : 0) + "\n");
}

const debugLine = (f: CliFlags) => (f.debug ? (line: string) => process.stderr.write(`debug: ${line}\n`) : undefined);

async function scaffoldPlan(input: string, f: CliFlags) {
  emit(
    f,
    await scaffoldPlanObject(input, {
      noCache: f.noCache,
      debug: debugLine(f),
      cutsFrom: f.cutsFrom,
      minDuration: f.minDuration,
      pad: f.pad,
      fillerPadBefore: f.fillerPadBefore,
      fillerPadEnd: f.fillerPadEnd,
      highlightsFrom: f.highlightsFrom,
      count: f.count,
      minScore: f.minScore,
    }),
  );
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const f = parseArgs(rest);
  const input = f.positional[0];

  switch (command) {
    case undefined:
    case "help":
    case "__help__":
      process.stdout.write(USAGE + "\n");
      process.exit(command ? 0 : 2);
    case "version": {
      const { ffmpegVersion } = await import("../media/ffmpeg.js");
      emit(f, { toolkit: "0.1.0", ffmpeg: await ffmpegVersion("ffmpeg") });
      return;
    }
    case "inspect": {
      if (!input) throw new ToolError("SOURCE_NOT_FOUND", "usage: video inspect <input>");
      emit(f, await cachedInspect(input, { noCache: f.noCache, debug: debugLine(f) }));
      return;
    }
    case "plan": {
      if (!input) throw new ToolError("SOURCE_NOT_FOUND", "usage: video plan <input>");
      await scaffoldPlan(input, f);
      return;
    }
    case "validate": {
      if (!input) throw new ToolError("PLAN_SCHEMA_INVALID", "usage: video validate <plan>");
      const r = await validatePlan(input, { noCache: f.noCache, debug: debugLine(f) });
      emit(f, {
        valid: r.valid,
        errors: r.errors,
        warnings: r.warnings,
        timelineDuration: r.timelineDuration,
      });
      process.exitCode = r.valid ? 0 : 1;
      return;
    }
    case "preview":
    case "render": {
      if (!input) throw new ToolError("PLAN_SCHEMA_INVALID", `usage: video ${command} <plan>`);
      const mode = command === "preview" ? "preview" : (f.mode ?? "final");
      const result = await renderPlan(input, {
        mode,
        force: f.force,
        encoder: f.encoder,
        noCache: f.noCache,
        debug: debugLine(f),
        onProgress: (p) => {
          if (p.percent !== null) {
            process.stderr.write(`\r${mode}: ${p.percent.toFixed(0)}%   `);
          }
        },
      });
      process.stderr.write("\n");
      emit(f, result);
      return;
    }
    case "diagnose": {
      emit(f, await diagnose());
      return;
    }
    case "detect-silence": {
      if (!input) throw new ToolError("SOURCE_NOT_FOUND", "usage: video detect-silence <input>");
      emit(
        f,
        await detectSilence(
          input,
          { thresholdDb: f.threshold ?? 35, minDurationSec: f.minDuration ?? 0.5 },
          { noCache: f.noCache, debug: debugLine(f) },
        ),
      );
      return;
    }
    case "detect-scenes": {
      if (!input) throw new ToolError("SOURCE_NOT_FOUND", "usage: video detect-scenes <input>");
      emit(
        f,
        await detectScenes(
          input,
          { threshold: f.threshold ?? 0.4 },
          { noCache: f.noCache, debug: debugLine(f) },
        ),
      );
      return;
    }
    case "extract-frame": {
      if (!input) throw new ToolError("SOURCE_NOT_FOUND", "usage: video extract-frame <input>");
      const at = f.at
        ?.split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n >= 0);
      emit(
        f,
        await extractFrames(input, {
          at: at && at.length > 0 ? at : undefined,
          count: f.count,
          size: f.size,
          dir: f.dir,
          noCache: f.noCache,
          debug: debugLine(f),
        }),
      );
      return;
    }
    case "review-frames": {
      if (!input) throw new ToolError("SOURCE_NOT_FOUND", "usage: video review-frames <input>");
      if (!f.scenes) {
        throw new ToolError("OBSERVATION_INVALID", "review-frames needs --scenes <scenes.json>");
      }
      let doc: unknown;
      try {
        doc = JSON.parse(await (await import("node:fs/promises")).readFile(f.scenes, "utf8"));
      } catch {
        throw new ToolError("OBSERVATION_INVALID", `scenes file is missing or not valid JSON: ${f.scenes}`);
      }
      const parsed = SceneReport.safeParse(doc);
      if (!parsed.success) {
        throw new ToolError("OBSERVATION_INVALID", "file is not a valid scene report", { file: f.scenes });
      }
      emit(
        f,
        await reviewFrames(input, parsed.data, {
          perBoundary: f.perBoundary,
          window: f.window,
          size: f.size,
          dir: f.dir,
          noCache: f.noCache,
          debug: debugLine(f),
        }),
      );
      return;
    }
    case "generate-proxy": {
      if (!input) throw new ToolError("SOURCE_NOT_FOUND", "usage: video generate-proxy <input>");
      emit(
        f,
        await generateProxy(input, {
          width: f.width,
          output: f.output,
          noCache: f.noCache,
          debug: debugLine(f),
        }),
      );
      return;
    }
    case "transcribe": {
      if (!input) throw new ToolError("SOURCE_NOT_FOUND", "usage: video transcribe <input>");
      emit(
        f,
        await transcribeInput(input, {
          engine: f.engine,
          model: f.model,
          chunkSeconds: f.chunk,
          snapToSilence: f.noSnap ? false : undefined,
          concurrency: f.concurrency,
          noCache: f.noCache,
          debug: debugLine(f),
        }),
      );
      return;
    }
    case "detect-filler": {
      if (!input) {
        throw new ToolError("OBSERVATION_INVALID", "usage: video detect-filler <transcript.json>");
      }
      let doc: unknown;
      try {
        doc = JSON.parse(await (await import("node:fs/promises")).readFile(input, "utf8"));
      } catch {
        throw new ToolError("OBSERVATION_INVALID", `transcript file is missing or not valid JSON: ${input}`);
      }
      const parsed = TranscriptReport.safeParse(doc);
      if (!parsed.success) {
        throw new ToolError("OBSERVATION_INVALID", "file is not a valid transcript report", {
          file: input,
        });
      }
      const phrases = f.words
        ? f.words.split(",").map((w) => w.trim()).filter(Boolean)
        : DEFAULT_FILLER_PHRASES;
      emit(f, {
        instances: detectFillerInstances(parsed.data, phrases),
        duration: parsed.data.duration,
        params: { phrases },
      });
      return;
    }
    case "captions": {
      if (!input) throw new ToolError("OBSERVATION_INVALID", "usage: video captions <transcript.json>");
      emit(
        f,
        await generateCaptions(input, { plan: f.plan, output: f.output, noCache: f.noCache, debug: debugLine(f) }),
      );
      return;
    }
    case "find-highlights": {
      if (!input) throw new ToolError("SOURCE_NOT_FOUND", "usage: video find-highlights <input>");
      if (!f.transcript) {
        throw new ToolError("OBSERVATION_INVALID", "find-highlights needs --transcript <t.json>");
      }
      let doc: unknown;
      try {
        const { readFile } = await import("node:fs/promises");
        doc = JSON.parse(await readFile(f.transcript, "utf8"));
      } catch {
        throw new ToolError("OBSERVATION_INVALID", `transcript file is missing or not valid JSON: ${f.transcript}`);
      }
      const parsed = TranscriptReport.safeParse(doc);
      if (!parsed.success) {
        throw new ToolError("OBSERVATION_INVALID", "file is not a valid transcript report", { file: f.transcript });
      }
      const silence = await detectSilence(input, { thresholdDb: 35, minDurationSec: 0.3 }, { noCache: f.noCache, debug: debugLine(f) });
      emit(
        f,
        scoreHighlights(parsed.data, SilenceReport.parse(silence), {
          keywords: f.keywords ? f.keywords.split(",").map((k) => k.trim()).filter(Boolean) : DEFAULT_HIGHLIGHT_PARAMS.keywords,
          minScore: f.minScore ?? DEFAULT_HIGHLIGHT_PARAMS.minScore,
          maxCount: f.count ?? DEFAULT_HIGHLIGHT_PARAMS.maxCount,
        }),
      );
      return;
    }
    case "mcp": {
      const { startStdioServer } = await import("../agent/mcp-server.js");
      startStdioServer();
      return;
    }
    case "benchmark": {
      if (!input) throw new ToolError("SOURCE_NOT_FOUND", "usage: video benchmark <input>");
      const r = await benchmarkInput(input, {
        noCache: f.noCache,
        seconds: f.seconds,
        debug: debugLine(f),
      });
      emit(f, r);
      return;
    }
    default:
      process.stderr.write(`unknown command: ${command}\n\n${USAGE}\n`);
      process.exit(2);
  }
}

main().catch((e: unknown) => {
  if (e instanceof ToolError) {
    process.stderr.write(JSON.stringify({ error: e.toJSON() }) + "\n");
  } else {
    process.stderr.write(
      JSON.stringify({
        error: {
          code: "INTERNAL",
          message: e instanceof Error ? e.message : String(e),
        },
      }) + "\n",
    );
    if (process.argv.includes("--debug") && e instanceof Error && e.stack) {
      process.stderr.write(e.stack + "\n");
    }
  }
  process.exit(1);
});
