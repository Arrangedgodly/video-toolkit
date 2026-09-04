import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";

// Spawns the built CLI (like mcp.test.ts / the bin test in integration.test.ts).
// help/version paths touch no media and no cache, so these run fast.

const BIN = path.resolve(import.meta.dirname, "..", "cli", "index.js");

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
