import { findHandy, handyTranscribeWav } from "./handy.js";
import {
  findWhisperCli,
  resolveWhisperModel,
  whisperModelUnavailable,
  whisperTranscribeWav,
  WHISPER_DEFAULT_MODEL,
} from "./whisper.js";
import { fail } from "../../core/errors.js";

/**
 * Engine boundary: an engine turns a 16kHz mono WAV into text. Engines that
 * emit native segments (their own timestamped segments, optionally with
 * per-word times) implement `transcribeSegments` — the orchestrator then
 * skips windowing entirely and runs ONE whole-file invocation. handy
 * (Parakeet) emits whole-file text only, so the orchestrator windows the
 * audio and stamps each window with its exact time range; whisper-cpp is
 * the native-segment engine (R2 measured windowing as pure overhead).
 */

export interface EngineTextResult {
  text: string;
  model: string;
  ms: number;
}

export interface EngineWord {
  start: number;
  end: number;
  text: string;
}

export interface EngineSegment {
  start: number;
  end: number;
  text: string;
  words?: EngineWord[];
}

export interface EngineSegmentsResult {
  segments: EngineSegment[];
  model: string;
  ms: number;
  language?: string;
}

export interface TranscriptionEngine {
  id: string;
  describe: string;
  detect(): Promise<{ available: boolean; detail: string }>;
  transcribeWav(wavPath: string, opts: { model?: string }): Promise<EngineTextResult>;
  /** Native-segment capability: when present the orchestrator honors it by
   * transcribing the WHOLE file in one invocation (no windows, no silence
   * snap; --chunk/--concurrency are no-ops). Implementing this is also the
   * word-timestamps capability: `opts.words` requests per-word times. */
  transcribeSegments?(
    wavPath: string,
    opts: { model?: string; words?: boolean; durationSecs?: number },
  ): Promise<EngineSegmentsResult>;
}

const handyEngine: TranscriptionEngine = {
  id: "handy",
  describe: "Handy (Parakeet via transcribe-cpp, Metal) — windowed, whole-text per chunk",
  async detect() {
    const bin = await findHandy();
    return {
      available: bin !== null,
      detail: bin ?? "Handy.app not found in /Applications or ~/Applications",
    };
  },
  async transcribeWav(wavPath, opts) {
    const bin = await findHandy();
    if (!bin) fail("TRANSCRIPTION_ENGINE_UNAVAILABLE", "Handy.app is not installed");
    const r = await handyTranscribeWav(bin, wavPath, { model: opts.model });
    return { text: r.text, model: r.model, ms: r.bestMs };
  },
};

export const whisperEngine: TranscriptionEngine = {
  id: "whisper-cpp",
  describe:
    "whisper.cpp (whisper-cli, Metal) — native segments + word timestamps; unwindowed whole-file invocation",
  async detect() {
    // R2: available = binary resolvable on PATH AND model resolvable per the
    // ordered table; the detail names both facts.
    const bin = await findWhisperCli();
    const model = resolveWhisperModel();
    const binFact = bin ?? "whisper-cli not found on PATH";
    const modelFact =
      model ?? `default model ${WHISPER_DEFAULT_MODEL} not found in .video-agent/models/ (cwd) nor <toolkit-root>/.video-agent/models/`;
    return { available: bin !== null && model !== null, detail: `${binFact}; ${modelFact}` };
  },
  async transcribeWav() {
    // whisper-cpp never goes through the windowed path (native segments);
    // reaching here is an orchestrator bug, not a user condition
    fail("TRANSCRIPTION_ENGINE_FAILED", "whisper-cpp does not implement whole-text transcribeWav");
  },
  async transcribeSegments(wavPath, opts) {
    const bin = await findWhisperCli();
    if (!bin) fail("TRANSCRIPTION_ENGINE_UNAVAILABLE", "whisper-cli is not on PATH");
    const model = resolveWhisperModel(opts.model);
    if (!model) whisperModelUnavailable(opts.model);
    return whisperTranscribeWav(bin, wavPath, { model, words: opts.words, durationSecs: opts.durationSecs });
  },
};

/** Priority order = agent-efficiency order; first available wins. handy stays
 * priority 1 (the default engine is untouched); whisper-cpp joins after it. */
export const ENGINES: TranscriptionEngine[] = [handyEngine, whisperEngine];

export async function resolveEngine(preferred?: string): Promise<TranscriptionEngine> {
  if (preferred) {
    const e = ENGINES.find((e) => e.id === preferred);
    if (!e) {
      fail("TRANSCRIPTION_ENGINE_UNAVAILABLE", `unknown engine '${preferred}'`, {
        known: ENGINES.map((e) => e.id),
      });
    }
    const d = await e.detect();
    if (!d.available) fail("TRANSCRIPTION_ENGINE_UNAVAILABLE", `engine '${preferred}': ${d.detail}`);
    return e;
  }
  for (const e of ENGINES) {
    const d = await e.detect();
    if (d.available) return e;
  }
  fail("TRANSCRIPTION_ENGINE_UNAVAILABLE", "no transcription engine available", {
    probed: await Promise.all(ENGINES.map(async (e) => `${e.id}: ${(await e.detect()).detail}`)),
  });
}
