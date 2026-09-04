import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { fail } from "../../core/errors.js";

/** Handy (com.pais.handy) ships a headless batch mode in its app binary:
 * `handy -f <16kHz-mono.wav> --json` prints one JSON object on stdout
 * (logs go to stderr) and exits. Verified against Parakeet TDT 0.6B v3. */

const CANDIDATE_PATHS = [
  "/Applications/Handy.app/Contents/MacOS/handy",
  `${homedir()}/Applications/Handy.app/Contents/MacOS/handy`,
];

export async function findHandy(): Promise<string | null> {
  for (const p of CANDIDATE_PATHS) {
    try {
      await access(p);
      return p;
    } catch {
      // keep looking
    }
  }
  return null;
}

export interface HandyTranscription {
  text: string;
  model: string;
  bestMs: number;
  audioSecs: number;
}

/** Parse handy's stdout JSON, tolerating surrounding whitespace/log noise. */
export function parseHandyJson(stdout: string): HandyTranscription {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end <= start) {
    fail("TRANSCRIPTION_ENGINE_FAILED", "handy produced no JSON on stdout", { stdout: stdout.slice(-300) });
  }
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(stdout.slice(start, end + 1)) as Record<string, unknown>;
  } catch (e) {
    fail("TRANSCRIPTION_ENGINE_FAILED", `handy stdout is not valid JSON: ${(e as Error).message}`);
  }
  return {
    text: String(doc.text ?? ""),
    model: String(doc.model ?? "unknown"),
    bestMs: Number(doc.best_ms ?? 0),
    audioSecs: Number(doc.audio_secs ?? 0),
  };
}

export async function handyTranscribeWav(
  binary: string,
  wavPath: string,
  opts: { model?: string; timeoutMs?: number } = {},
): Promise<HandyTranscription> {
  const timeoutMs = opts.timeoutMs ?? 300_000;
  return new Promise<HandyTranscription>((resolve, reject) => {
    const args = ["-f", wavPath, "--json"];
    if (opts.model) args.push("--model", opts.model);
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        child.kill("SIGKILL");
        settled = true;
        reject(
          new Error(`handy timed out after ${timeoutMs}ms on ${wavPath}`),
        );
      }
    }, timeoutMs);

    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        fail("TRANSCRIPTION_ENGINE_FAILED", `handy exited with code ${code}`, {
          stderrTail: stderr.trim().split("\n").slice(-10).join("\n"),
        });
      }
      try {
        resolve(parseHandyJson(stdout));
      } catch (e) {
        reject(e);
      }
    });
  });
}
