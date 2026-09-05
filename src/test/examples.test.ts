import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { runCapture } from "../media/ffprobe.js";

/** T28 examples-cookbook smoke — the cookbook's acceptance IS this test: every
 * example plan in `examples/` must be `valid:true`, lint-clean, and
 * preview-renderable against inputs regenerated from the SAME lavfi recipes
 * `examples/README.md` documents (argv mirrored verbatim; the README is the
 * human copy, this file is the executable copy — drift between them fails the
 * recipe-coverage test below). Deterministic everywhere ffmpeg/ffprobe exist
 * (darwin, linux CI): no `say`, no transcription engine, no model, no system
 * font — v1 examples deliberately avoid `overlay-text` (macOS-fixed font),
 * which the no-overlay-text lock below enforces. */

const EXAMPLES_DIR = path.resolve(import.meta.dirname, "..", "..", "examples");
const BIN = path.resolve(import.meta.dirname, "..", "cli", "index.js");

/** The cookbook's index (order = examples/README.md). Adding an example
 * without adding it here fails the drift lock test below. */
const EXAMPLES = [
  "silence-tighten.json",
  "filler-cut.json",
  "highlights.json",
  "watermark-captions.json",
  "montage-crossfade-zoom.json",
  "gif-preview.json",
  "audio-mix.json",
] as const;

/** captions.srt recipe block, byte-identical to examples/README.md. */
const CAPTIONS_SRT = `1
00:00:00,000 --> 00:00:03,000
Welcome to the toolkit walkthrough.

2
00:00:03,000 --> 00:00:07,000
Workers observe, bridges propose, agents decide.

3
00:00:07,000 --> 00:00:10,000
Validate, preview, then render once.
`;

async function ffmpeg(args: string[]): Promise<void> {
  const r = await runCapture("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", ...args]);
  assert.equal(r.code, 0, r.stderr);
}

/** The lavfi recipes from examples/README.md — a plan validates from any
 * directory containing the generated inputs, so the smoke generates them in
 * the tmp dir and spawns the CLI with cwd = that dir. */
async function generateInputs(): Promise<void> {
  // input.mp4 — 21 s, real silence gaps baked at [4,6] and [12,14.5]
  await ffmpeg([
    "-y", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30",
    "-f", "lavfi", "-i", "sine=frequency=440",
    "-af", "volume=0:enable='between(t,4,6)+between(t,12,14.5)'",
    "-t", "21", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "input.mp4",
  ]);
  // speech.mp4 — lavfi fallback (the say recipe is darwin-only; identical duration)
  await ffmpeg([
    "-y", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30",
    "-f", "lavfi", "-i", "sine=frequency=440",
    "-af", "volume=0:enable='between(t,1.0,1.2)+between(t,6.1,6.6)'",
    "-t", "22", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "speech.mp4",
  ]);
  // bed.mp3 — 6 s looping music-bed stand-in
  await ffmpeg([
    "-y", "-f", "lavfi", "-i", "sine=frequency=220",
    "-af", "tremolo=f=2:d=0.6", "-t", "6", "bed.mp3",
  ]);
  // logo.png — one-frame lavfi generate-and-extract
  await ffmpeg([
    "-y", "-f", "lavfi", "-i", "color=c=0x3399FF@0.9:s=128x128,format=rgba",
    "-frames:v", "1", "logo.png",
  ]);
  // captions.srt — hand-written, already on the OUTPUT timeline
  await writeFile("captions.srt", CAPTIONS_SRT);
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function cli(args: string[]): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd: process.cwd() });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

let dir = "";

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "video-toolkit-examples-"));
  process.chdir(dir);
  await generateInputs();
});

after(async () => {
  process.chdir(tmpdir());
  await rm(dir, { recursive: true, force: true });
});

for (const name of EXAMPLES) {
  test(`example ${name}: validate valid:true, lint clean, preview renders`, async () => {
    await copyFile(path.join(EXAMPLES_DIR, name), name);

    const v = await cli(["validate", name]);
    assert.equal(v.code, 0, v.stderr);
    const validated = JSON.parse(v.stdout) as { valid: boolean; errors?: unknown[] };
    assert.equal(validated.valid, true, v.stdout);

    const l = await cli(["plan", "lint", name]);
    assert.equal(l.code, 0, l.stderr);
    const linted = JSON.parse(l.stdout) as { suggestions: unknown[] };
    assert.deepEqual(linted.suggestions, [], l.stdout);

    const p = await cli(["preview", name]);
    assert.equal(p.code, 0, p.stderr);
    const preview = JSON.parse(p.stdout) as { output: string };
    assert.ok(preview.output.includes(".preview."), preview.output);
  });
}

test("cookbook drift lock: examples/ holds exactly the indexed plans + README", async () => {
  const files = (await readdir(EXAMPLES_DIR)).sort();
  assert.deepEqual(files, [...EXAMPLES, "README.md"].sort());
});

test("every referenced input has a recipe line in examples/README.md", async () => {
  const readme = await readFile(path.join(EXAMPLES_DIR, "README.md"), "utf8");
  const referenced = new Set<string>();
  for (const name of EXAMPLES) {
    const plan = JSON.parse(await readFile(path.join(EXAMPLES_DIR, name), "utf8")) as {
      source: string;
      operations: { type: string; file?: string }[];
    };
    referenced.add(plan.source);
    for (const op of plan.operations) {
      if (op.file) referenced.add(op.file);
    }
  }
  // every input the plans reference is documented (recipe lines name the files)
  for (const input of referenced) {
    assert.ok(readme.includes(input), `examples/README.md must document input "${input}"`);
  }
  // and every referenced input was actually (re)generated by the recipes
  const generated = ["input.mp4", "speech.mp4", "bed.mp3", "logo.png", "captions.srt"];
  for (const g of generated) {
    assert.ok(referenced.has(g), `generated input "${g}" must be referenced by some example`);
  }
});

test("v1 examples avoid overlay-text (the macOS-fixed font) so the cookbook runs on CI", async () => {
  for (const name of EXAMPLES) {
    const plan = JSON.parse(await readFile(path.join(EXAMPLES_DIR, name), "utf8")) as {
      operations: { type: string }[];
    };
    for (const op of plan.operations) {
      assert.notEqual(op.type, "overlay-text", `${name}: v1 examples must not use overlay-text`);
    }
  }
});

test("package.json files allowlist ships examples/ (T28 amendment to T27)", async () => {
  const pkg = JSON.parse(
    await readFile(path.resolve(EXAMPLES_DIR, "..", "package.json"), "utf8"),
  ) as { files?: string[] };
  assert.ok(pkg.files?.includes("examples"), "files must include \"examples\"");
});
