#!/usr/bin/env node
import readline from "node:readline";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { EncoderId } from "../media/ffmpeg.js";
import { cachedInspect } from "../cache/cache.js";
import { scaffoldPlanObject } from "../core/scaffold.js";
import { validatePlan } from "../validate/validate.js";
import { lintPlanFile } from "../validate/lint.js";
import { renderPlan } from "../render/render.js";
import { renderBatch } from "../render/batch.js";
import { diagnose } from "../hardware/diagnose.js";
import { runDoctor } from "../doctor/doctor.js";
import { benchmarkInput } from "../benchmark/benchmark.js";
import { catalogTransitions } from "../media/transitions.js";
import { detectSilence } from "../analysis/silence.js";
import { detectScenes } from "../analysis/scenes.js";
import { extractFrames } from "../analysis/frames.js";
import { reviewFrames } from "../analysis/review-frames.js";
import { generateProxy } from "../analysis/proxy.js";
import { transcribeInput } from "../analysis/transcribe/index.js";
import { detectFillerInstances, DEFAULT_FILLER_PHRASES } from "../analysis/filler.js";
import { scoreHighlights, DEFAULT_HIGHLIGHT_PARAMS } from "../analysis/highlights.js";
import { measureLoudness } from "../analysis/measure-loudness.js";
import { generateCaptions } from "../captions/generate.js";
import { SceneReport, SilenceReport, TranscriptReport } from "../core/schemas.js";
import { readFile } from "node:fs/promises";
import { ToolError } from "../core/errors.js";
// R6 progress policy lives in the HTTP adapter (the committed home of the
// sink); the stdio transport imports the SAME factory + conformance predicate
// instead of duplicating the throttle (isLoopbackHost precedent). The resulting
// module cycle is safe: every cross-reference is a hoisted function declaration
// used only at call time, never during module evaluation.
import { conformingProgressToken, createProgressSink } from "./mcp-http.js";

/**
 * MCP server core + stdio adapter (JSON-RPC, newline-delimited). Thin: every
 * tool call dispatches to the same engine functions the CLI uses — no logic
 * here. `handleMessage` is the transport-neutral JSON-RPC dispatcher shared by
 * the stdio transport (`startStdioServer`) and the streamable-HTTP transport
 * (`src/agent/mcp-http.ts`); protocol semantics are identical on every
 * transport. Enables MCP clients (ZCode, Claude, etc.) without touching the
 * engine. (T30) stdio speaks R6's progress contract too: a `tools/call`
 * carrying a conforming `_meta.progressToken` receives
 * `notifications/progress` as stdout JSON LINES while the tool runs, then the
 * single final response line; every other request shape stays byte-identical.
 */

/** Protocol revisions this server speaks (initialize-era; see
 * docs/ultron/research/r4-mcp-streamable-http.md). */
export const KNOWN_PROTOCOL_VERSIONS: ReadonlySet<string> = new Set([
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
]);

/** One incoming JSON-RPC message (request or notification). */
export interface McpMessage {
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
}

/** One outgoing JSON-RPC response (key order is load-bearing: stdio writes
 * these verbatim as single lines and tests lock the exact bytes). */
export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface DispatchOptions {
  /** Streamable-HTTP policy: echo the client's protocolVersion when known,
   * else answer 2025-06-18 (the revision the server targets). Stdio keeps
   * its historical behavior: echo whatever was sent, else 2024-11-05. */
  negotiateProtocolVersion?: boolean;
  /** Raw progress events for the long tools — video_render / video_preview
   * forward renderPlan's existing onProgress hook verbatim (fed by the ffmpeg
   * progress parse); video_render_batch forwards the AGGREGATED overall
   * ((Σ per-plan fractions)/N × 100, per src/render/batch.ts — T23, R6's
   * named future sink-firing). (T26) BATCH events additionally carry the
   * optional formatted `message` ("plan i/N (<basename>): P% — overall O%");
   * render/preview events omit it (the sink's own default message names the
   * encoded time). Both transports pass one for a token-carrying `tools/call`
   * — HTTP into SSE frames, stdio into stdout JSON LINES (T30); absent (CLI,
   * no-token requests) = no notifications, byte-identical output.
   * Throttling + monotonicity are transport policy (R6: the sink lives in
   * src/agent/mcp-http.ts — shared by both transports since T30). */
  onProgress?: (p: { percent: number | null; timeSec: number; message?: string }) => void;
}

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
    name: "video_plan_lint",
    description:
      "Advisory lint of a VALID plan (the judgment layer between validate and preview): deterministic suggestions over the compiled timeline — REDUNDANT_TRIM, REDUNDANT_CUT, MERGEABLE_TRIMS (gap ≤ 0.01 s), NOOP_VOLUME, NOOP_CUT (< 0.01 s of kept time), OVERLAPPING_CUTS, SUBSECOND_SEGMENT (< 0.5 s). Workers propose, agents decide: suggestions are never auto-applied, fix is advisory text, and lint never changes validate's verdict (exit 0 always). An invalid plan returns validate's own report (valid:false, existing codes).",
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
    name: "video_render_batch",
    description:
      "Render multiple plans with bounded parallelism. plans = plan file paths, directories (the *.json files directly inside, non-recursive, sorted), or * globs. A failing/invalid plan is REPORTED in results[]/summary.failures — the batch always runs to completion, and per-plan failures never set isError (only a batch-level error such as invalid jobs does). jobs default = the FIRST plan's source cached benchmark renderConcurrency recommendation when an integer in 1..4, else 1. force passes through to every render (each render's own overwrite guards stay intact). Payload = CLI stdout shape; exit-code semantics are the CLI's (0 iff all succeeded).",
    inputSchema: {
      type: "object",
      properties: {
        plans: { type: "array", items: str },
        jobs: { type: "number" },
        force: { type: "boolean" },
      },
      required: ["plans"],
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
      "Timestamped transcript. Engines: handy (Parakeet; windowed, boundaries snapped to silence, windows run with bounded parallelism via concurrency, default 1 or the cached benchmark recommendation — report byte-identical to sequential) or whisper-cpp (native segments from ONE whole-file invocation; chunk/concurrency are no-ops). word_timestamps=true requests per-word times (segments[].words) and selects whisper-cpp when no engine is given. Model resolution (whisper-cpp): explicit resolvable path > .video-agent/models/<name> in the cwd, then under the toolkit root's .video-agent/models/ > default ggml-base.en.bin at the same two locations, else TRANSCRIPTION_ENGINE_UNAVAILABLE listing known models (both dirs). Cached per source+engine+model+chunk (+words flag for whisper-cpp).",
    inputSchema: {
      type: "object",
      properties: {
        input: str,
        engine: str,
        model: str,
        chunk_seconds: { type: "number" },
        snap_to_silence: { type: "boolean" },
        concurrency: { type: "number" },
        word_timestamps: { type: "boolean" },
      },
      required: ["input"],
    },
  },
  {
    name: "video_detect_filler",
    description:
      "Filler-word candidates from a transcript report; params.precision = \"words\" (exact per-word anchors, whisper-cpp --word-timestamps) or \"segments\" (linear estimates within segment granularity).",
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
    description: "Transcript -> .srt or .vtt (format from the output extension, or explicit format); with a plan, cue times remap through the plan's cuts (splitting cues that span cuts).",
    inputSchema: {
      type: "object",
      properties: {
        transcript: str,
        output: str,
        plan: str,
        format: { type: "string", enum: ["srt", "vtt"] },
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
    name: "video_doctor",
    description:
      "One-command dependency diagnosis: node vs engines, ffmpeg/ffprobe, subtitles/drawtext filters, encoders incl. hardware, the overlay font, transcription engines (Handy, whisper-cli + model resolution across both models dirs), `say`, and cache writability (cwd + toolkit root) — each check with impact + remediation. status ok|degraded|broken (broken = core binaries missing: ffmpeg/ffprobe absent or node below engines; degraded = optional capabilities missing). The report is ALWAYS the payload — broken is not an isError (payload = CLI stdout shape).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "video_benchmark",
    description: "Measure fastest encoder/concurrency on this machine for a given input.",
    inputSchema: {
      type: "object",
      properties: { input: str, seconds: { type: "number" } },
      required: ["input"],
    },
  },
  {
    name: "video_measure_loudness",
    description:
      "Loudness observation (loudnorm first pass): integrated loudness (LUFS), true peak (dBTP), loudness range, threshold of the source audio. Cached per source; writes no media file. The evidence for normalize-audio targeting: gain to reach a target = target − inputI dB, or set normalize-audio.target directly. Audio-less source → {duration, note}.",
    inputSchema: {
      type: "object",
      properties: { input: str },
      required: ["input"],
    },
  },
  {
    name: "video_transitions",
    description:
      "Crossfade transition kinds available on this ffmpeg build, parsed live from `ffmpeg -h filter=xfade` and cached per version — the discovery surface for a plan's crossfade.kind. Duration guidance: 0.2–1.0 s typical; fade is the cheapest and empirically validated kind; all kinds share the same duration/offset semantics.",
    inputSchema: { type: "object", properties: {} },
  },
];

async function callTool(
  name: string,
  a: Record<string, unknown>,
  onProgress?: DispatchOptions["onProgress"],
): Promise<unknown> {
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
      return {
        valid: r.valid,
        errors: r.errors,
        warnings: r.warnings,
        timelineDuration: r.timelineDuration,
        // crossfade plans: the fade + the adjusted expectation (CLI parity)
        ...(r.crossfadeDuration !== undefined
          ? { crossfadeDuration: r.crossfadeDuration, expectedDuration: r.expectedDuration }
          : {}),
      };
    }
    case "video_plan_lint": {
      // payload = CLI stdout shape: {suggestions:[…]} on a valid plan; on an
      // invalid plan the EXISTING validate report (a normal result, exactly
      // video_validate's shape for the same input — exit-code semantics are
      // the CLI's)
      const r = await lintPlanFile(String(a.plan));
      if (!r.valid) {
        const v = r.validation;
        return {
          valid: false,
          errors: v.errors,
          warnings: v.warnings,
          timelineDuration: v.timelineDuration,
          ...(v.crossfadeDuration !== undefined
            ? { crossfadeDuration: v.crossfadeDuration, expectedDuration: v.expectedDuration }
            : {}),
        };
      }
      return { suggestions: r.suggestions };
    }
    case "video_preview":
      // progress sink threaded through (R6): raw events only — the transport
      // owns throttle/monotonicity policy; absent (CLI / no-token) = silent
      return renderPlan(String(a.plan), { mode: "preview", force: a.force === true, onProgress });
    case "video_render":
      return renderPlan(String(a.plan), {
        force: a.force === true,
        encoder: a.encoder as EncoderId | undefined,
        onProgress,
      });
    case "video_render_batch":
      return renderBatch(
        Array.isArray(a.plans) ? a.plans.map((p) => String(p)) : [],
        {
          jobs: a.jobs as number | undefined,
          force: a.force === true,
          // (T23) overall-batch progress (R6's named future sink-firing):
          // raw aggregate events — the transport sink owns throttle/
          // monotonicity; absent (CLI / no-token) = silent, byte-identical
          onProgress,
        },
      );
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
        concurrency: a.concurrency as number | undefined,
        wordTimestamps: a.word_timestamps === true,
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
      const phrases = (a.words as string[] | undefined) ?? DEFAULT_FILLER_PHRASES;
      const detection = detectFillerInstances(parsed.data, phrases);
      return {
        instances: detection.instances,
        duration: parsed.data.duration,
        params: { phrases, precision: detection.precision },
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
        format: a.format !== undefined ? String(a.format) : undefined,
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
    case "video_doctor":
      // the report IS the payload — a broken environment is a diagnosis,
      // not a tool failure (exit-code semantics are the CLI's)
      return runDoctor();
    case "video_benchmark":
      return benchmarkInput(String(a.input), { seconds: a.seconds as number | undefined });
    case "video_measure_loudness":
      return measureLoudness(String(a.input));
    case "video_transitions":
      return catalogTransitions();
    default:
      throw new ToolError("OPERATION_INVALID", `unknown tool: ${name}`);
  }
}

/** Transport-neutral JSON-RPC dispatcher. Returns the response object for a
 * request, or null when the message is a notification (no response). Wrappers
 * frame the result: stdio writes it as one JSON line, HTTP answers 200 JSON /
 * 202 empty. Behavior is byte-identical to the pre-HTTP stdio server. */
export async function handleMessage(
  msg: McpMessage,
  opts: DispatchOptions = {},
): Promise<JsonRpcResponse | null> {
  const respond = (id: unknown, result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result });
  const respondError = (id: unknown, code: number, message: string): JsonRpcResponse => ({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });

  const { id, method, params } = msg;
  switch (method) {
    case "initialize": {
      const requested = params?.protocolVersion;
      const protocolVersion = opts.negotiateProtocolVersion
        ? typeof requested === "string" && KNOWN_PROTOCOL_VERSIONS.has(requested)
          ? requested
          : "2025-06-18"
        : ((requested as string | undefined) ?? "2024-11-05");
      return respond(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "video-toolkit", version: "0.1.0" },
      });
    }
    case "notifications/initialized":
    case "initialized":
      return null; // notification — no response
    case "ping":
      return respond(id, {});
    case "tools/list":
      return respond(id, { tools: TOOLS });
    case "tools/call": {
      const name = String(params?.name ?? "");
      const args = (params?.arguments as Record<string, unknown>) ?? {};
      try {
        const result = await callTool(name, args, opts.onProgress);
        return respond(id, { content: [{ type: "text", text: JSON.stringify(result) }] });
      } catch (e) {
        const payload =
          e instanceof ToolError
            ? { error: e.toJSON() }
            : { error: { code: "INTERNAL", message: e instanceof Error ? e.message : String(e) } };
        return respond(id, {
          content: [{ type: "text", text: JSON.stringify(payload) }],
          isError: true,
        });
      }
    }
    default:
      return id !== undefined ? respondError(id, -32601, `method not found: ${method}`) : null;
  }
}

/**
 * (T30) Build the stdio progress sink for ONE incoming message: the SAME
 * `createProgressSink` the HTTP transport uses (R6's committed dual gate
 * ≥ 250 ms AND ≥ 1.0 point, strict monotonicity, token echoed verbatim,
 * `total: 100`), wrapped so `notifications/progress` objects go to `write` —
 * for the live server that is one JSON object per `\n` on stdout, stdio's
 * native framing where HTTP writes SSE frames. Same contract, different wire.
 * Returns undefined for every message shape that must stay byte-identical (no
 * token, non-conforming token, or a non-`tools/call` method — R6's
 * degradation rule, e.g. tools/list WITH a token is response-only), so the
 * caller simply omits the option. `write` and `now` are injectable: units
 * capture frames through an in-memory writer on a fake clock — no real
 * timing dependence. Stateless per request; dead once the response is written.
 */
export function stdioProgressSink(
  msg: McpMessage,
  write: (obj: unknown) => void,
  now: () => number = Date.now,
): DispatchOptions["onProgress"] | undefined {
  const token = conformingProgressToken(msg);
  if (token === undefined) return undefined;
  return createProgressSink(token, write, now);
}

export function startStdioServer(): void {
  const write = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + "\n");
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: McpMessage;
    try {
      msg = JSON.parse(trimmed) as McpMessage;
    } catch {
      return;
    }
    // (T30) a token-carrying tools/call streams notifications/progress as
    // stdout LINES while the tool runs; the response line still comes LAST
    // (the sink writes during handleMessage, the response after it resolves;
    // single-threaded synchronous writes keep the order). Every other shape
    // passes no sink — output byte-identical to the pre-T30 server.
    const onProgress = stdioProgressSink(msg, write);
    void handleMessage(msg, onProgress !== undefined ? { onProgress } : {}).then((res) => {
      if (res !== null) write(res);
    });
  });
}

// Auto-start only when this file is the executed entry point — direct
// (`node dist/agent/mcp-server.js`) or via the npm bin (`video-mcp`, a symlink
// whose path does not end in "mcp-server.js"). Compare real paths on both
// sides so the bin symlink resolves to this file. A plain import (the CLI's
// `mcp` case) does not auto-start; it calls startStdioServer() itself.
function invokedAsMain(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false; // argv[1] missing/unresolvable — treat as an import
  }
}

if (invokedAsMain()) {
  startStdioServer();
}
