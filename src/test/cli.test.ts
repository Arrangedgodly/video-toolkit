import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCapture } from "../media/ffprobe.js";

// Spawns the built CLI (like mcp.test.ts / the bin test in integration.test.ts).
// help/version paths touch no media and no cache, so those run fast. The
// `plan lint` regressions (T24) generate their own 6 s fixture in a tmpdir —
// lint rides validate's metadata probe, so a real media source is required.

const BIN = path.resolve(import.meta.dirname, "..", "cli", "index.js");
const FIXTURE = "cli-lint-fixture.mp4";
let dir = "";

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "video-toolkit-cli-"));
  process.chdir(dir);
  const r = await runCapture("ffmpeg", [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30",
    "-f", "lavfi", "-i", "sine=frequency=440",
    "-t", "6", "-c:v", "libx264", "-crf", "28", "-pix_fmt", "yuv420p",
    "-c:a", "aac", FIXTURE,
  ]);
  assert.equal(r.code, 0, r.stderr);

  await writeFile("lint-plan.json", JSON.stringify({
    version: 1,
    source: FIXTURE,
    operations: [
      { type: "trim", start: 0, end: 4 },
      { type: "trim", start: 1, end: 3 }, // redundant: inside operation 1
      { type: "volume", db: 0 }, // identity
    ],
    output: { path: "lint-out.mp4" },
  }));
  await writeFile("lint-bad-schema.json", JSON.stringify({
    version: 1,
    source: FIXTURE,
    operations: [{ type: "nonsense" }],
    output: { path: "lint-bad.mp4" },
  }));
  await writeFile("lint-bad-range.json", JSON.stringify({
    version: 1,
    source: FIXTURE,
    operations: [{ type: "trim", start: 0, end: 999 }],
    output: { path: "lint-bad-range.mp4" },
  }));
});

after(async () => {
  process.chdir(tmpdir());
  await rm(dir, { recursive: true, force: true });
});

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(...args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d));
    child.stderr.on("data", (d: Buffer) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

function assertUsage(r: RunResult): void {
  assert.ok(
    r.stdout.startsWith("video — agent-native video editing toolkit"),
    `stdout should start with the usage banner, got: ${r.stdout.slice(0, 60)}`,
  );
  assert.ok(r.stdout.includes("usage: video <command> [args] [flags]"));
}

test("CLI: --help as first token prints usage on stdout and exits 0", async () => {
  const r = await run("--help");
  assert.equal(r.code, 0);
  assertUsage(r);
  assert.equal(r.stderr, "");
});

test("CLI: -h as first token prints usage on stdout and exits 0", async () => {
  const r = await run("-h");
  assert.equal(r.code, 0);
  assertUsage(r);
  assert.equal(r.stderr, "");
});

test("CLI: help command prints usage on stdout and exits 0", async () => {
  const r = await run("help");
  assert.equal(r.code, 0);
  assertUsage(r);
  assert.equal(r.stderr, "");
});

test("CLI: bare video (no command) prints usage on stdout and exits 2", async () => {
  const r = await run();
  assert.equal(r.code, 2);
  assertUsage(r);
  assert.equal(r.stderr, "");
});

test("CLI: --help after a command is not an input path (usage, exit 0)", async () => {
  // Regression: `video inspect --help` used to push the literal `__help__` into
  // positionals and stat a file named `__help__` (INTERNAL ENOENT, exit 1).
  const r = await run("inspect", "--help");
  assert.equal(r.code, 0);
  assertUsage(r);
  assert.equal(r.stderr, "");
  assert.ok(!r.stderr.includes("__help__"));
});

test("CLI: -h after a command behaves the same (usage, exit 0)", async () => {
  const r = await run("transcribe", "-h");
  assert.equal(r.code, 0);
  assertUsage(r);
  assert.equal(r.stderr, "");
});

test("CLI: version prints {toolkit, ffmpeg} JSON and exits 0", async () => {
  const r = await run("version");
  assert.equal(r.code, 0);
  assert.equal(r.stderr, "");
  const parsed = JSON.parse(r.stdout) as { toolkit: string; ffmpeg: string };
  assert.equal(parsed.toolkit, "0.1.0");
  assert.ok(parsed.ffmpeg.length > 0, "ffmpeg version is probed at call time");
});

// ---- plan lint (T24): advisory, exit 0 always on a valid plan

test("CLI: plan lint exits 0 with single-line suggestions JSON on stdout", async () => {
  const r = await run("plan", "lint", "lint-plan.json");
  assert.equal(r.code, 0);
  assert.equal(r.stderr, "");
  assert.equal(r.stdout.trimEnd().split("\n").length, 1, "compact single-line JSON");
  const parsed = JSON.parse(r.stdout) as {
    suggestions: { code: string; operation?: number; message: string; fix?: string }[];
  };
  assert.deepEqual(
    parsed.suggestions.map((s) => [s.code, s.operation]),
    [["REDUNDANT_TRIM", 2], ["NOOP_VOLUME", 3]],
  );
  assert.ok(parsed.suggestions[0]!.message.includes("[1.000, 3.000]"));
  assert.ok(parsed.suggestions[0]!.fix!.includes("remove operation 2"));
});

test("CLI: plan lint --pretty pretty-prints the same report", async () => {
  const r = await run("plan", "lint", "lint-plan.json", "--pretty");
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("\n  "), "indented multi-line JSON");
  const parsed = JSON.parse(r.stdout) as { suggestions: { code: string }[] };
  assert.deepEqual(parsed.suggestions.map((s) => s.code), ["REDUNDANT_TRIM", "NOOP_VOLUME"]);
});

test("CLI: plan lint on a clean valid plan exits 0 with an empty report", async () => {
  await (await import("node:fs/promises")).writeFile("lint-clean.json", JSON.stringify({
    version: 1,
    source: FIXTURE,
    operations: [{ type: "trim", start: 0, end: 4 }],
    output: { path: "lint-clean-out.mp4" },
  }));
  const r = await run("plan", "lint", "lint-clean.json");
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trimEnd(), '{"suggestions":[]}');
});

test("CLI: plan lint on a schema-invalid plan -> existing machine-readable error, exit 1", async () => {
  const r = await run("plan", "lint", "lint-bad-schema.json");
  assert.equal(r.code, 1);
  assert.equal(r.stdout, "");
  const err = JSON.parse(r.stderr) as { error: { code: string } };
  assert.equal(err.error.code, "PLAN_SCHEMA_INVALID"); // existing codes — lint adds none
});

test("CLI: plan lint on a range-invalid plan -> validate's own report on stdout, exit 1", async () => {
  const r = await run("plan", "lint", "lint-bad-range.json");
  assert.equal(r.code, 1);
  const parsed = JSON.parse(r.stdout) as {
    valid: boolean;
    errors: { code: string }[];
    suggestions?: unknown;
  };
  assert.equal(parsed.valid, false);
  assert.equal(parsed.errors[0]!.code, "TIMESTAMP_OUT_OF_RANGE");
  assert.equal(parsed.suggestions, undefined, "an invalid plan gets validate's contract, not suggestions");
});

test("CLI: plan lint on a missing plan file -> existing SOURCE_NOT_FOUND, exit 1", async () => {
  const r = await run("plan", "lint", "no-such-plan.json");
  assert.equal(r.code, 1);
  const err = JSON.parse(r.stderr) as { error: { code: string } };
  assert.equal(err.error.code, "SOURCE_NOT_FOUND");
});

test("CLI: collision rule — a lone `lint` positional is still a source path", async () => {
  // `video plan lint` (no second positional) scaffolds a source literally
  // named "lint" — it must NOT run the lint subcommand (no suggestions
  // output); the failure is the pre-existing missing-source path
  const r = await run("plan", "lint");
  assert.notEqual(r.code, 0);
  assert.ok(!r.stdout.includes("suggestions"));
});
