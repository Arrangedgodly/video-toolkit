#!/usr/bin/env node
import readline from "node:readline";
import type { EncoderId } from "../media/ffmpeg.js";
import { cachedInspect } from "../cache/cache.js";
import { scaffoldPlanObject } from "../core/scaffold.js";
import { validatePlan } from "../validate/validate.js";
import { renderPlan } from "../render/render.js";
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
import { readFile } from "node:fs/promises";
import { ToolError } from "../core/errors.js";

/**
 * MCP stdio adapter (JSON-RPC, newline-delimited). Thin: every tool call
 * dispatches to the same engine functions the CLI uses — no logic here.
 * Enables MCP clients (ZCode, Claude, etc.) without touching the engine.
 */

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const str = { type: "string" } as const;

const TOOLS: ToolDef[] = [
  {
    name: "video_inspect",
    description: "Structured media metadata for a video/audio file (duration, streams, codecs).",
    inputSchema: { type: "object", properties: { input: str }, required: ["input"] },
  },
  {
    name: "video_plan",
    description:
      "Scaffold a valid edit plan for a source. Optionally expand a silence report into cut operations (pad kept each side), a filler report into cut operations (pads expand beyond the segment-granularity estimate), or a highlight report into top-N trim operations (a compilation). One bridge per call.",
    inputSchema: {
      type: "object",
      properties: {
        input: str,
        cuts_from: str,
        min_duration: { type: "number" },
        pad: { type: "number" },
        filler_pad_before: { type: "number" },
        filler_pad_end: { type: "number" },
        highlights_from: str,
        count: { type: "number" },
        min_score: { type: "number" },
      },
      required: ["input"],
    },
  },
  {
    name: "video_validate",
    description: "Validate an edit plan; returns machine-readable errors with stable codes.",
    inputSchema: { type: "object", properties: { plan: str }, required: ["plan"] },
  },
  {
    name: "video_preview",
    description: "Cheap preview render of a plan (<output>.preview.mp4).",
    inputSchema: {
      type: "object",
      properties: { plan: str, force: { type: "boolean" } },
      required: ["plan"],
    },
  },
  {
    name: "video_render",
    description: "Final single-pass render of a validated plan.",
    inputSchema: {
      type: "object",
      properties: {
        plan: str,
        force: { type: "boolean" },
        encoder: { type: "string", enum: ["libx264", "h264_videotoolbox"] },
      },
      required: ["plan"],
    },
  },
  {
    name: "video_detect_silence",
    description: "Silence gaps as timestamped observations; cached per source+params.",
    inputSchema: {
      type: "object",
      properties: {
        input: str,
        threshold_db: { type: "number" },
        min_duration_sec: { type: "number" },
      },
      required: ["input"],
    },
  },
  {
    name: "video_detect_scenes",
    description: "Scene-cut boundaries with confidence scores; cached per source+params.",
    inputSchema: {
      type: "object",
      properties: { input: str, threshold: { type: "number" } },
      required: ["input"],
    },
  },
  {
    name: "video_review_frames",
    description:
      "Grouped jpg stills around every boundary of a scenes report (per-boundary evenly spaced stills in a ±window/2 span, downscaled) for agent visual review; fresh on demand, no cache.",
    inputSchema: {
      type: "object",
      properties: {
        input: str,
        scenes: str,
        per_boundary: { type: "number" },
        window: { type: "number" },
        size: { type: "number" },
        dir: str,
      },
      required: ["input", "scenes"],
    },
  },
  {
    name: "video_transcribe",
    description:
      "Timestamped transcript (windowed; boundaries snapped to silence). Engine: handy (Parakeet). Cached per source+engine+model+chunk.",
    inputSchema: {
      type: "object",
      properties: {
        input: str,
        engine: str,
        model: str,
        chunk_seconds: { type: "number" },
        snap_to_silence: { type: "boolean" },
      },
      required: ["input"],
    },
  },
  {
    name: "video_detect_filler",
    description: "Filler-word candidates from a transcript report (times are estimates within segment granularity).",
    inputSchema: {
      type: "object",
      properties: {
        transcript: str,
        words: { type: "array", items: { type: "string" } },
      },
      required: ["transcript"],
    },
  },
  {
    name: "video_find_highlights",
    description: "Deterministic highlight proposals (speech rate, pause emphasis, keyword hits) from a transcript; the agent decides.",
    inputSchema: {
      type: "object",
      properties: {
        input: str,
        transcript: str,
        keywords: { type: "array", items: { type: "string" } },
        min_score: { type: "number" },
        count: { type: "number" },
      },
      required: ["input", "transcript"],
    },
  },
  {
    name: "video_captions",
    description: "Transcript -> .srt; with a plan, cue times remap through the plan's cuts (splitting cues that span cuts).",
    inputSchema: {
      type: "object",
      properties: {
        transcript: str,
        output: str,
        plan: str,
      },
      required: ["transcript"],
    },
  },
  {
    name: "video_extract_frames",
    description: "Extract viewable jpg stills at timestamps (or evenly spaced).",
    inputSchema: {
      type: "object",
      properties: {
        input: str,
        at: { type: "array", items: { type: "number" } },
        count: { type: "number" },
        size: { type: "number" },
      },
      required: ["input"],
    },
  },
  {
    name: "video_generate_proxy",
    description: "Low-cost review copy (default 480w).",
    inputSchema: {
      type: "object",
      properties: { input: str, width: { type: "number" }, output: str },
      required: ["input"],
    },
  },
  { name: "video_diagnose", description: "Environment + ffmpeg capabilities.", inputSchema: { type: "object", properties: {} } },
  {
    name: "video_benchmark",
    description: "Measure fastest encoder/concurrency on this machine for a given input.",
    inputSchema: {
      type: "object",
      properties: { input: str, seconds: { type: "number" } },
      required: ["input"],
    },
  },
];

async function callTool(name: string, a: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "video_inspect":
      return cachedInspect(String(a.input));
    case "video_plan":
      return scaffoldPlanObject(String(a.input), {
        cutsFrom: a.cuts_from !== undefined ? String(a.cuts_from) : undefined,
        minDuration: a.min_duration as number | undefined,
        pad: a.pad as number | undefined,
        fillerPadBefore: a.filler_pad_before as number | undefined,
        fillerPadEnd: a.filler_pad_end as number | undefined,
        highlightsFrom: a.highlights_from !== undefined ? String(a.highlights_from) : undefined,
        count: a.count as number | undefined,
        minScore: a.min_score as number | undefined,
      });
    case "video_validate": {
      const r = await validatePlan(String(a.plan));
      return { valid: r.valid, errors: r.errors, warnings: r.warnings, timelineDuration: r.timelineDuration };
    }
    case "video_preview":
      return renderPlan(String(a.plan), { mode: "preview", force: a.force === true });
    case "video_render":
      return renderPlan(String(a.plan), {
        force: a.force === true,
        encoder: a.encoder as EncoderId | undefined,
      });
    case "video_detect_silence":
      return detectSilence(String(a.input), {
        thresholdDb: (a.threshold_db as number | undefined) ?? 35,
        minDurationSec: (a.min_duration_sec as number | undefined) ?? 0.5,
      });
    case "video_detect_scenes":
      return detectScenes(String(a.input), { threshold: (a.threshold as number | undefined) ?? 0.4 });
    case "video_review_frames": {
      let doc: unknown;
      try {
        doc = JSON.parse(await readFile(String(a.scenes), "utf8"));
      } catch {
        throw new ToolError("OBSERVATION_INVALID", `scenes file is missing or not valid JSON: ${a.scenes}`);
      }
      const parsed = SceneReport.safeParse(doc);
      if (!parsed.success) {
        throw new ToolError("OBSERVATION_INVALID", "file is not a valid scene report", {
          file: String(a.scenes),
        });
      }
      return reviewFrames(String(a.input), parsed.data, {
        perBoundary: a.per_boundary as number | undefined,
        window: a.window as number | undefined,
        size: a.size as number | undefined,
        dir: a.dir !== undefined ? String(a.dir) : undefined,
      });
    }
    case "video_transcribe":
      return transcribeInput(String(a.input), {
        engine: a.engine !== undefined ? String(a.engine) : undefined,
        model: a.model !== undefined ? String(a.model) : undefined,
        chunkSeconds: a.chunk_seconds as number | undefined,
        snapToSilence: a.snap_to_silence as boolean | undefined,
      });
    case "video_detect_filler": {
      let doc: unknown;
      try {
        doc = JSON.parse(await readFile(String(a.transcript), "utf8"));
      } catch {
        throw new ToolError("OBSERVATION_INVALID", `transcript file is missing or not valid JSON: ${a.transcript}`);
      }
      const parsed = TranscriptReport.safeParse(doc);
      if (!parsed.success) {
        throw new ToolError("OBSERVATION_INVALID", "file is not a valid transcript report");
      }
      return {
        instances: detectFillerInstances(parsed.data, (a.words as string[] | undefined) ?? DEFAULT_FILLER_PHRASES),
        duration: parsed.data.duration,
      };
    }
    case "video_find_highlights": {
      let doc: unknown;
      try {
        doc = JSON.parse(await readFile(String(a.transcript), "utf8"));
      } catch {
        throw new ToolError("OBSERVATION_INVALID", `transcript file is missing or not valid JSON: ${a.transcript}`);
      }
      const parsed = TranscriptReport.safeParse(doc);
      if (!parsed.success) {
        throw new ToolError("OBSERVATION_INVALID", "file is not a valid transcript report");
      }
      const silence = await detectSilence(String(a.input), { thresholdDb: 35, minDurationSec: 0.3 });
      return scoreHighlights(parsed.data, SilenceReport.parse(silence), {
        keywords: (a.keywords as string[] | undefined) ?? DEFAULT_HIGHLIGHT_PARAMS.keywords,
        minScore: (a.min_score as number | undefined) ?? DEFAULT_HIGHLIGHT_PARAMS.minScore,
        maxCount: (a.count as number | undefined) ?? DEFAULT_HIGHLIGHT_PARAMS.maxCount,
      });
    }
    case "video_captions":
      return generateCaptions(String(a.transcript), {
        output: a.output !== undefined ? String(a.output) : undefined,
        plan: a.plan !== undefined ? String(a.plan) : undefined,
      });
    case "video_extract_frames":
      return extractFrames(String(a.input), {
        at: a.at as number[] | undefined,
        count: a.count as number | undefined,
        size: a.size as number | undefined,
      });
    case "video_generate_proxy":
      return generateProxy(String(a.input), {
        width: a.width as number | undefined,
        output: a.output !== undefined ? String(a.output) : undefined,
      });
    case "video_diagnose":
      return diagnose();
    case "video_benchmark":
      return benchmarkInput(String(a.input), { seconds: a.seconds as number | undefined });
    default:
      throw new ToolError("OPERATION_INVALID", `unknown tool: ${name}`);
  }
}

export function startStdioServer(): void {
  const write = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + "\n");
  const respond = (id: unknown, result: unknown) => write({ jsonrpc: "2.0", id, result });
  const respondError = (id: unknown, code: number, message: string) =>
    write({ jsonrpc: "2.0", id, error: { code, message } });

  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: { id?: unknown; method?: string; params?: Record<string, unknown> };
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return;
    }
    const { id, method, params } = msg;
    void (async () => {
      switch (method) {
        case "initialize":
          respond(id, {
            protocolVersion: (params?.protocolVersion as string) ?? "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "video-toolkit", version: "0.1.0" },
          });
          break;
        case "notifications/initialized":
        case "initialized":
          break; // notification — no response
        case "ping":
          respond(id, {});
          break;
        case "tools/list":
          respond(id, { tools: TOOLS });
          break;
        case "tools/call": {
          const name = String(params?.name ?? "");
          const args = (params?.arguments as Record<string, unknown>) ?? {};
          try {
            const result = await callTool(name, args);
            respond(id, { content: [{ type: "text", text: JSON.stringify(result) }] });
          } catch (e) {
            const payload =
              e instanceof ToolError
                ? { error: e.toJSON() }
                : { error: { code: "INTERNAL", message: e instanceof Error ? e.message : String(e) } };
            respond(id, {
              content: [{ type: "text", text: JSON.stringify(payload) }],
              isError: true,
            });
          }
          break;
        }
        default:
          if (id !== undefined) respondError(id, -32601, `method not found: ${method}`);
      }
    })();
  });
}

if (process.argv[1]?.endsWith("mcp-server.js")) {
  startStdioServer();
}
