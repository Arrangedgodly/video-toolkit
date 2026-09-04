import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { runCapture } from "../media/ffprobe.js";
import { Cache } from "../cache/cache.js";
import { ffmpegVersion } from "../media/ffmpeg.js";
import { ToolError } from "../core/errors.js";
import { expandPlanArgs, renderBatch, type BatchReport } from "../render/batch.js";

// T22 — `render-batch`: expansion determinism, jobs derivation, per-plan
// failure capture under mapBounded, CLI exit codes, MCP parity. Plans use
// preview output mode (renders land on <out>.preview.mp4, ultrafast) on tiny
// fixtures so the suite stays fast.

const FIXTURE = "batch-fx.mp4"; // 4s, 320x180, 440Hz tone
const FIXTURE2 = "batch-fx2.mp4"; // 1s, 320x180 — a SECOND source (first-plan
//                                 rule probe: this one has NO benchmark cache)
const CLI = path.resolve(import.meta.dirname, "..", "cli", "index.js");
const SERVER = path.resolve(import.meta.dirname, "..", "agent", "mcp-server.js");
let dir = "";
let child: ChildProcess | null = null; // MCP stdio server (parity test)
const responses = new Map<number, unknown>();
let nextId = 0;

function plan(source: string, operations: unknown[], output: string): unknown {
  return { version: 1, source, operations, output: { path: output, mode: "preview" } };
}

async function writePlan(name: string, p: unknown): Promise<string> {
  await writeFile(name, JSON.stringify(p));
  return name;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function isOperationInvalid(e: unknown): boolean {
  return e instanceof ToolError && e.code === "OPERATION_INVALID";
}

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "video-toolkit-batch-"));
  process.chdir(dir);
  const r = await runCapture("ffmpeg", [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25",
    "-f", "lavfi", "-i", "sine=frequency=440",
    "-t", "4", "-c:v", "libx264", "-crf", "30", "-pix_fmt", "yuv420p",
    "-c:a", "aac", FIXTURE,
  ]);
  assert.equal(r.code, 0, r.stderr);
  const r2 = await runCapture("ffmpeg", [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25",
    "-t", "1", "-c:v", "libx264", "-crf", "30", "-pix_fmt", "yuv420p",
    "-an", FIXTURE2,
  ]);
  assert.equal(r2.code, 0, r2.stderr);
});

after(async () => {
  child?.kill();
  process.chdir(tmpdir());
  await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- expansion

test("expandPlanArgs: directory arg = the *.json FILES directly inside, non-recursive, sorted", async () => {
  await mkdir("trees/sub", { recursive: true });
  await mkdir("trees/sub.json", { recursive: true }); // a DIRECTORY named *.json
  await writeFile("trees/b.json", "{}");
  await writeFile("trees/a.json", "{}");
  await writeFile("trees/c.txt", "{}");
  await writeFile("trees/sub/inside.json", "{}");
  await writeFile("trees/sub.json/nested.json", "{}");
  assert.deepEqual(await expandPlanArgs(["trees"]), [
    path.join("trees", "a.json"),
    path.join("trees", "b.json"),
  ]);
});

test("expandPlanArgs: literal args pass through verbatim (order preserved), nonexistent carried for per-plan reporting", async () => {
  assert.deepEqual(
    await expandPlanArgs(["trees/b.json", "trees/a.json"]),
    [path.join("trees", "b.json"), path.join("trees", "a.json")],
  );
  assert.deepEqual(await expandPlanArgs(["nope.json"]), ["nope.json"]);
  // arg order is preserved; each arg's own expansion is sorted
  assert.deepEqual(await expandPlanArgs(["nope.json", "trees"]), [
    "nope.json",
    path.join("trees", "a.json"),
    path.join("trees", "b.json"),
  ]);
});

test("expandPlanArgs: minimal * glob — matches within one directory, sorted, no match contributes nothing", async () => {
  await mkdir("globby", { recursive: true });
  await writeFile("globby/x2.json", "{}");
  await writeFile("globby/x1.json", "{}");
  await writeFile("globby/y.txt", "{}");
  await writeFile("globby/xa.md", "{}");
  assert.deepEqual(await expandPlanArgs(["globby/x*.json"]), [
    path.join("globby", "x1.json"),
    path.join("globby", "x2.json"),
  ]);
  assert.deepEqual(await expandPlanArgs(["globby/nomatch*.json"]), []);
  // cwd-level pattern (dirname = "."): bare sorted names
  await writeFile("root-marker-a.json", "{}");
  await writeFile("root-marker-b.json", "{}");
  assert.deepEqual(await expandPlanArgs(["*marker*.json"]), [
    "root-marker-a.json",
    "root-marker-b.json",
  ]);
});

// ------------------------------------------------------------ jobs guards

test("render-batch: --jobs must be an integer >= 1 (OPERATION_INVALID, checked before any expansion work)", async () => {
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    await assert.rejects(
      renderBatch(["whatever.json"], { jobs: bad }),
      (e: unknown) => isOperationInvalid(e),
      `jobs=${bad} should be rejected`,
    );
  }
});

test("render-batch: no plans matched is a batch-level OPERATION_INVALID", async () => {
  await assert.rejects(
    renderBatch(["nomatch-*.json"]),
    (e: unknown) => isOperationInvalid(e) && /no plan files/i.test((e as Error).message),
  );
});

// ------------------------------------------- mixed batch: capture + ordering

test("render-batch: invalid + failing plans are REPORTED while valid plans still render; results index-aligned (slowest first)", async () => {
  // input order: bad-schema, SLOWEST valid, tiny valid, bad-source, tiny valid
  // — completion order differs from input order, results must NOT follow it
  const plans = [
    await writePlan("m0.json", { version: 1, source: FIXTURE, operations: [{ type: "bogus" }], output: { path: "m0.mp4" } }),
    await writePlan("m1.json", plan(FIXTURE, [{ type: "trim", start: 0, end: 3.5 }], "m1.mp4")),
    await writePlan("m2.json", plan(FIXTURE, [{ type: "trim", start: 0, end: 0.4 }], "m2.mp4")),
    await writePlan("m3.json", plan("missing-source.mp4", [{ type: "trim", start: 0, end: 0.4 }], "m3.mp4")),
    await writePlan("m4.json", plan(FIXTURE, [{ type: "trim", start: 0.4, end: 0.8 }], "m4.mp4")),
  ];
  const report = await renderBatch(plans, { jobs: 2 });

  // summary shape + counts
  assert.equal(report.summary.rendered, 3);
  assert.equal(report.summary.failed, 2);
  assert.equal(report.summary.jobs, 2);
  assert.ok(Number.isFinite(report.summary.wallMs));
  assert.deepEqual(
    report.summary.failures.map((f) => f.code),
    ["PLAN_SCHEMA_INVALID", "SOURCE_NOT_FOUND"],
  );
  assert.ok(report.summary.failures.every((f) => typeof f.plan === "string" && f.message.length > 0));

  // deterministic input ordering regardless of completion order
  assert.deepEqual(
    report.results.map((r) => r.plan),
    plans,
  );
  assert.deepEqual(
    report.results.map((r) => r.ok),
    [false, true, true, false, true],
  );
  // per-plan results carry the RenderResult (success) or the error (failure)
  for (const r of report.results) {
    if (r.ok) {
      assert.ok(r.result, "success carries the full RenderResult");
      assert.equal(r.result!.command[0], "ffmpeg"); // each render: ONE ffmpeg pass
      assert.equal(r.output, r.result!.output);
      assert.ok(await exists(r.output!));
      assert.equal(r.error, undefined);
    } else {
      assert.ok(r.error, "failure carries the machine-readable error");
      assert.match(r.error!.code, /^(PLAN_SCHEMA_INVALID|SOURCE_NOT_FOUND)$/);
      assert.equal(r.result, undefined);
    }
  }
});

// -------------------------------------------- overwrite guard (--force pass)

test("render-batch: OUTPUT_EXISTS collision reported, not thrown; --force passes through to every render", async () => {
  await writeFile("collide.preview.mp4", "pretend"); // plans render preview mode
  const collide = await writePlan("c1.json", plan(FIXTURE, [{ type: "trim", start: 0, end: 0.4 }], "collide.mp4"));
  const fresh = await writePlan("c2.json", plan(FIXTURE, [{ type: "trim", start: 0, end: 0.4 }], "c-fresh.mp4"));

  const noForce = await renderBatch([collide, fresh]);
  assert.equal(noForce.summary.rendered, 1);
  assert.equal(noForce.summary.failed, 1);
  assert.equal(noForce.results[0]!.error!.code, "OUTPUT_EXISTS");
  assert.equal(noForce.results[1]!.ok, true);

  const forced = await renderBatch([collide, fresh], { force: true });
  assert.equal(forced.summary.failed, 0, forced.summary.failures.map((f) => f.message).join("; "));
  assert.ok(await exists("collide.preview.mp4"));
  assert.ok(await exists("c-fresh.preview.mp4"));
});

// ------------------------------------------------ jobs default (first plan)

test("render-batch: jobs default = FIRST plan's source cached benchmark renderConcurrency (T5 law), else 1", async () => {
  const cache = new Cache();
  const benchName = `benchmark-${await ffmpegVersion("ffmpeg")}.json`;
  const idFx = await cache.sourceId(FIXTURE);

  // sane measured recommendation 3 → jobs 3 (force: sub-batches re-render)
  await cache.write(idFx, benchName, { recommended: { encoder: "libx264", renderConcurrency: 3 } });
  const p1 = await writePlan("j1.json", plan(FIXTURE, [{ type: "trim", start: 0, end: 0.4 }], "j1.mp4"));
  const p2 = await writePlan("j2.json", plan(FIXTURE2, [{ type: "trim", start: 0, end: 0.5 }], "j2.mp4"));
  let r = await renderBatch([p1, p2], { force: true }); // FIRST plan source = FIXTURE (cached 3)
  assert.equal(r.summary.jobs, 3);
  // FIRST-plan rule (not any/last): FIXTURE2 (no cache) first → conservative 1
  r = await renderBatch([p2, p1], { force: true });
  assert.equal(r.summary.jobs, 1);
  // clamp: an out-of-range recommendation (9) falls back to 1
  await cache.write(idFx, benchName, { recommended: { encoder: "libx264", renderConcurrency: 9 } });
  r = await renderBatch([p1, p2], { force: true });
  assert.equal(r.summary.jobs, 1);
  // unreadable first plan (raw invalid JSON) → default 1, failure still reported per-plan
  await writeFile("j-bad.json", "{not json");
  const bad = "j-bad.json";
  r = await renderBatch([bad, p1], { force: true });
  assert.equal(r.summary.jobs, 1);
  assert.equal(r.summary.failed, 1);
  assert.equal(r.summary.failures[0]!.code, "PLAN_INVALID_JSON");
});

// --------------------------------------------------------- CLI exit codes

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(...args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [CLI, ...args]);
    let stdout = "";
    let stderr = "";
    c.stdout.on("data", (d: Buffer) => (stdout += d));
    c.stderr.on("data", (d: Buffer) => (stderr += d));
    c.on("error", reject);
    c.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

test("CLI render-batch: all-valid directory → exit 0, summary on stdout, per-plan stderr lines", async () => {
  await mkdir("clidir-ok", { recursive: true });
  await writePlan(path.join("clidir-ok", "a.json"), plan(FIXTURE, [{ type: "trim", start: 0, end: 0.4 }], "cli-a.mp4"));
  await writePlan(path.join("clidir-ok", "b.json"), plan(FIXTURE, [{ type: "trim", start: 0.4, end: 0.8 }], "cli-b.mp4"));
  const r = await runCli("render-batch", "clidir-ok", "--jobs", "2");
  assert.equal(r.code, 0, r.stderr);
  const report = JSON.parse(r.stdout) as BatchReport;
  assert.equal(report.summary.rendered, 2);
  assert.equal(report.summary.failed, 0);
  assert.equal(report.summary.jobs, 2);
  assert.deepEqual(report.results.map((x) => path.basename(x.plan)), ["a.json", "b.json"]);
  assert.ok(r.stderr.includes("[1/2]") && r.stderr.includes("a.json"), r.stderr);
  assert.ok(await exists("cli-a.preview.mp4") && await exists("cli-b.preview.mp4"));
});

test("CLI render-batch: one bad-source + one OUTPUT_EXISTS collision in the batch → exit 1, rendered count correct, both reported", async () => {
  await mkdir("clidir-mixed", { recursive: true });
  await writeFile("cli-collide.preview.mp4", "pretend"); // plans render preview mode
  await writePlan(path.join("clidir-mixed", "a.json"), plan(FIXTURE, [{ type: "trim", start: 0, end: 0.4 }], "cli-c.mp4"));
  await writePlan(path.join("clidir-mixed", "b.json"), plan("missing-source.mp4", [{ type: "trim", start: 0, end: 0.4 }], "cli-d.mp4"));
  await writePlan(path.join("clidir-mixed", "c.json"), plan(FIXTURE, [{ type: "trim", start: 0, end: 0.4 }], "cli-collide.mp4"));
  const r = await runCli("render-batch", "clidir-mixed", "--jobs", "2");
  assert.equal(r.code, 1);
  const report = JSON.parse(r.stdout) as BatchReport;
  assert.equal(report.summary.rendered, 1);
  assert.equal(report.summary.failed, 2);
  assert.deepEqual(
    report.summary.failures.map((f) => f.code).sort(),
    ["OUTPUT_EXISTS", "SOURCE_NOT_FOUND"],
  );
  assert.ok(await exists("cli-c.preview.mp4")); // the valid plan still rendered
});

test("CLI render-batch: invalid --jobs and no-args usage errors are machine-readable, exit 1", async () => {
  const badJobs = await runCli("render-batch", "clidir-ok", "--jobs", "1.5");
  assert.equal(badJobs.code, 1);
  assert.equal((JSON.parse(badJobs.stderr).error as { code: string }).code, "OPERATION_INVALID");

  const noArgs = await runCli("render-batch");
  assert.equal(noArgs.code, 1);
  assert.equal((JSON.parse(noArgs.stderr).error as { code: string }).code, "PLAN_SCHEMA_INVALID");
  assert.match(noArgs.stderr, /usage: video render-batch/);
});

// ------------------------------------------------------------- MCP parity

function mcpRequest(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = ++nextId;
  child!.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }) + "\n");
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = setInterval(() => {
      if (responses.has(id)) {
        clearInterval(poll);
        resolve(responses.get(id) as Record<string, unknown>);
      } else if (Date.now() - started > 30000) {
        clearInterval(poll);
        reject(new Error(`timeout waiting for ${method} (id ${id})`));
      }
    }, 20);
  });
}

test("MCP: video_render_batch payload = CLI stdout shape; per-plan failures NEVER set isError", async () => {
  child = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "ignore"] });
  let pending = "";
  child.stdout!.on("data", (d: Buffer) => {
    pending += d.toString();
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as { id?: number };
        if (msg.id !== undefined) responses.set(msg.id, msg);
      } catch {
        // ignore malformed frames
      }
    }
  });

  const good = await writePlan("mp1.json", plan(FIXTURE, [{ type: "trim", start: 0, end: 0.4 }], "mp1.mp4"));
  const bad = await writePlan("mp2.json", plan("missing-source.mp4", [{ type: "trim", start: 0, end: 0.4 }], "mp2.mp4"));
  const r = await mcpRequest("tools/call", {
    name: "video_render_batch",
    arguments: { plans: [good, bad], jobs: 2 },
  });
  const result = r.result as { isError?: boolean; content: { text: string }[] };
  assert.notEqual(result.isError, true, "per-plan failures ride in the summary, never isError");
  const data = JSON.parse(result.content[0]!.text) as BatchReport;
  assert.equal(data.summary.rendered, 1);
  assert.equal(data.summary.failed, 1);
  assert.equal(data.summary.jobs, 2);
  assert.equal(data.summary.failures[0]!.code, "SOURCE_NOT_FOUND");
  assert.deepEqual(data.results.map((x) => x.plan), [good, bad]);
  assert.ok(await exists("mp1.preview.mp4"));

  // a BATCH-level error (bad jobs) still surfaces as isError + machine code
  const r2 = await mcpRequest("tools/call", {
    name: "video_render_batch",
    arguments: { plans: [good], jobs: 0 },
  });
  const result2 = r2.result as { isError?: boolean; content: { text: string }[] };
  assert.equal(result2.isError, true);
  const errPayload = JSON.parse(result2.content[0]!.text) as { error: { code: string } };
  assert.equal(errPayload.error.code, "OPERATION_INVALID");
});
