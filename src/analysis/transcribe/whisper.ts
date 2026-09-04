import { spawn } from "node:child_process";
import { access, constants, readFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fail } from "../../core/errors.js";
import { round3 } from "../runner.js";
import type { EngineSegment } from "./engines.js";

/** whisper.cpp engine (T10). Binding contract: docs/ultron/research/
 * r2-whisper-word-timestamps.md (committed disposition) — implemented here
 * verbatim, not reinvented:
 *   whisper-cli -m <ABSOLUTE_MODEL_PATH> -f <16kHz-mono.wav> -ojf -of <TMP_PREFIX>
 * writes EXACTLY ONE file <TMP_PREFIX>.json (stdout = human segment lines,
 * stderr = ggml/Metal logs — both ignored; the JSON file is the only channel).
 * NO -l / -wt / -ml / -sow / -dtw / -nfa flags (all measured harmful or
 * no-ops on this build, see R2's candidate table). */

export const WHISPER_CLI = "whisper-cli";
/** `.video-agent/` is the repo's established cwd-relative convention (the
 * cache lives at .video-agent/cache); models live beside it. */
export const WHISPER_MODELS_DIR = path.join(".video-agent", "models");
export const WHISPER_DEFAULT_MODEL = "ggml-base.en.bin";

let toolkitRootCache: string | null = null;

/** The toolkit's own install root, derived from THIS module's location
 * (src|dist /analysis/transcribe/whisper.* → the package root owning
 * package.json). Showcase defect fix (coordinator-sanctioned): model
 * resolution was cwd-only, so `video transcribe --word-timestamps` failed
 * with TRANSCRIPTION_ENGINE_UNAVAILABLE from any cwd outside the repo even
 * though the model is provisioned at the repo's .video-agent/models. */
export function whisperToolkitRoot(): string {
  if (toolkitRootCache === null) {
    const here = path.dirname(fileURLToPath(import.meta.url));
    let dir = here;
    while (!existsSync(path.join(dir, "package.json"))) {
      const parent = path.dirname(dir);
      if (parent === dir) {
        // filesystem root hit without a package.json — fall back to the
        // module's fixed depth (<root>/(src|dist)/analysis/transcribe/)
        dir = path.resolve(here, "..", "..", "..");
        break;
      }
      dir = parent;
    }
    toolkitRootCache = dir;
  }
  return toolkitRootCache;
}

/** Ordered models-dir candidates: the cwd-relative convention first (R2's
 * table, unchanged), then the toolkit root's own .video-agent/models — so a
 * model provisioned in the repo resolves from ANY cwd. Injectable for tests. */
export function whisperModelsDirs(): string[] {
  return [WHISPER_MODELS_DIR, path.join(whisperToolkitRoot(), WHISPER_MODELS_DIR)];
}

/** Resolve whisper-cli on PATH (executable bit checked). null when absent. */
export async function findWhisperCli(): Promise<string | null> {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, WHISPER_CLI);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

/** R2's ordered model-resolution table (binding), EXTENDED (defect fix) with
 * a second location: each name is tried in `<cwd>/.video-agent/models/` and
 * then in `<toolkit-root>/.video-agent/models/`. Returns the resolved path,
 * or null when nothing resolves (callers turn that into the machine-readable
 * listing error). Explicit paths win verbatim; then the models-dir name per
 * location; then the provisioned default per location. whisper-cli itself
 * does NO name magic and NO download, so the engine ALWAYS passes an
 * explicitly resolved `-m`. The dirs parameter is injectable for tests. */
export function resolveWhisperModel(explicit?: string, dirs: string[] = whisperModelsDirs()): string | null {
  if (explicit) {
    if (existsSync(explicit)) return explicit; // rule 1: verbatim
    for (const d of dirs) {
      const named = path.join(d, explicit);
      if (existsSync(named)) return named; // rule 2: models-dir name, per location
    }
    return null;
  }
  for (const d of dirs) {
    const def = path.join(d, WHISPER_DEFAULT_MODEL);
    if (existsSync(def)) return def; // rule 3: provisioned default, per location
  }
  return null;
}

/** Rule 4 terminal failure: TRANSCRIPTION_ENGINE_UNAVAILABLE with a sorted
 * `*.bin` listing of EVERY candidate models dir (paths prefixed by their
 * dir; absent/empty dirs say so in the note). */
export function whisperModelUnavailable(explicit?: string, dirs: string[] = whisperModelsDirs()): never {
  const known: string[] = [];
  const notes: string[] = [];
  for (const d of dirs) {
    try {
      const bins = readdirSync(d).filter((f) => f.endsWith(".bin"));
      if (bins.length === 0) notes.push(`${d}/ is empty`);
      else known.push(...bins.map((f) => path.join(d, f)));
    } catch {
      notes.push(`${d}/ not found`);
    }
  }
  known.sort();
  return fail("TRANSCRIPTION_ENGINE_UNAVAILABLE", `no whisper.cpp model resolvable for '${explicit ?? "default"}'`, {
    known,
    ...(notes.length > 0 ? { note: notes.join("; ") } : {}),
  });
}

// ---- parser (pure; unit-tested against the committed fixture) ----

interface WhisperToken {
  text: string;
  offsets: { from: number; to: number };
}
interface WhisperSegment {
  offsets: { from: number; to: number };
  text: string;
  tokens: WhisperToken[];
}
interface WhisperOjf {
  transcription?: WhisperSegment[];
  result?: { language?: string };
  model?: { type?: string; multilingual?: boolean };
}

/** Token → word merge + zero-width repair, exactly per R2's parse contract:
 * skip `[_*` specials; a leading-space token starts a new word; any other
 * token (punctuation, BPE tails) appends its text and extends `end` to
 * max(end, to); a zero-width word (end <= start) is repaired to the next
 * word's start IN THE SAME SEGMENT, else left zero-width (never invented).
 * Operates on the raw integer-millisecond offsets; parseWhisperOjf converts
 * the result to seconds at 3 decimals. */
export function mergeWhisperWords(tokens: WhisperToken[]): { start: number; end: number; text: string }[] {
  const words: { start: number; end: number; text: string }[] = [];
  for (const tok of tokens) {
    const t = tok.text ?? "";
    if (t.startsWith("[_")) continue; // [_BEG_] / [_TT_*] specials
    const from = tok.offsets?.from ?? 0;
    const to = tok.offsets?.to ?? from;
    if (t.startsWith(" ")) {
      const trimmed = t.trim();
      if (trimmed.length > 0) words.push({ text: trimmed, start: from, end: to });
    } else if (words.length > 0) {
      const w = words[words.length - 1]!;
      w.text += t;
      w.end = Math.max(w.end, to);
    }
    // a no-leading-space token before any word (defensive): nothing to append to
  }
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (w.end <= w.start) {
      const next = words[i + 1];
      if (next && next.start > w.start) w.end = next.start; // repair in-segment
    }
  }
  return words;
}

/** Parse the `-ojf` JSON text into native segments (ms → s, 3 decimals).
 * Words are always derived here; the engine drops them when the caller did
 * not request `--word-timestamps`. `timestamps` display strings are ignored
 * (offsets are the ground truth). */
export function parseWhisperOjf(json: string): {
  segments: EngineSegment[];
  language?: string;
} {
  let doc: WhisperOjf;
  try {
    doc = JSON.parse(json) as WhisperOjf;
  } catch (e) {
    fail("TRANSCRIPTION_ENGINE_FAILED", `whisper-cli JSON output is not valid JSON: ${(e as Error).message}`);
  }
  const raw = Array.isArray(doc.transcription) ? doc.transcription : [];
  const segments: EngineSegment[] = [];
  for (const seg of raw) {
    const text = (seg.text ?? "").trim();
    if (text.length === 0) continue;
    segments.push({
      start: round3((seg.offsets?.from ?? 0) / 1000),
      end: round3((seg.offsets?.to ?? 0) / 1000),
      text,
      words: mergeWhisperWords(seg.tokens ?? []).map((w) => ({
        text: w.text,
        start: round3(w.start / 1000),
        end: round3(w.end / 1000),
      })),
    });
  }
  segments.sort((a, b) => a.start - b.start);
  return { segments, language: doc.result?.language };
}

// ---- spawn (argv array + timeout, INVARIANT 5; mirrors handy.ts) ----

export interface WhisperSegmentsResult {
  segments: EngineSegment[];
  model: string;
  ms: number;
  language?: string;
}

export async function whisperTranscribeWav(
  binary: string,
  wavPath: string,
  opts: { model: string; words?: boolean; durationSecs?: number; timeoutMs?: number } ,
): Promise<WhisperSegmentsResult> {
  const started = Date.now();
  // R2 recommends `60s + 2× audio duration` (≥11× headroom over the worst
  // measured RTF 0.177); callers may override (tests).
  const timeoutMs = opts.timeoutMs ?? 60_000 + Math.ceil((opts.durationSecs ?? 0) * 1000 * 2);
  return new Promise<WhisperSegmentsResult>((resolve, reject) => {
    // -of prefix in a tmp dir; the ONLY emitted file is <prefix>.json
    const prefix = `${wavPath}.whisper`;
    const args = ["-m", opts.model, "-f", wavPath, "-ojf", "-of", prefix];
    const child = spawn(binary, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        child.kill("SIGKILL");
        settled = true;
        reject(new Error(`whisper-cli timed out after ${timeoutMs}ms on ${wavPath}`));
      }
    }, timeoutMs);

    child.stderr.on("data", (d: Buffer) => (stderr += d.toString())); // ggml logs — diagnostics only
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
        fail("TRANSCRIPTION_ENGINE_FAILED", `whisper-cli exited with code ${code}`, {
          stderrTail: stderr.trim().split("\n").slice(-10).join("\n"),
        });
      }
      // availability probes (findWhisperCli + resolveWhisperModel) run before
      // spawn, so a non-zero exit here is a transcription failure, not a
      // missing-binary/model condition
      readFile(`${prefix}.json`, "utf8")
        .then((json) => {
          try {
            const parsed = parseWhisperOjf(json);
            const segments = opts.words
              ? parsed.segments
              : parsed.segments.map(({ start, end, text }) => ({ start, end, text }));
            resolve({
              segments,
              model: opts.model,
              ms: Date.now() - started,
              ...(parsed.language ? { language: parsed.language } : {}),
            });
          } catch (e) {
            reject(e);
          }
        })
        .catch((e: unknown) =>
          fail("TRANSCRIPTION_ENGINE_FAILED", `whisper-cli wrote no JSON output at ${prefix}.json`, {
            reason: (e as Error).message,
          }),
        );
    });
  });
}
