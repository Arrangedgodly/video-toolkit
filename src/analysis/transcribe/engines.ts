import { findHandy, handyTranscribeWav } from "./handy.js";
import { fail } from "../../core/errors.js";

/**
 * Engine boundary: an engine turns a 16kHz mono WAV into text. Engines that
 * emit native segments should grow a `transcribeSegments` method and skip
 * windowing; handy (Parakeet) emits whole-file text only, so the orchestrator
 * windows the audio and stamps each window with its exact time range.
 */

export interface EngineTextResult {
  text: string;
  model: string;
  ms: number;
}

export interface TranscriptionEngine {
  id: string;
  describe: string;
  detect(): Promise<{ available: boolean; detail: string }>;
  transcribeWav(wavPath: string, opts: { model?: string }): Promise<EngineTextResult>;
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

/** Priority order = agent-efficiency order; first available wins. */
export const ENGINES: TranscriptionEngine[] = [handyEngine];

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
