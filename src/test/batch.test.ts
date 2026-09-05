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
import {
  createBatchProgressAggregator,
  expandPlanArgs,
  renderBatch,
  type BatchProgressEvent,
  type BatchReport,
} from "../render/batch.js";

// T22 — `render-batch`: expansion determinism, jobs derivation, per-plan
// failure capture under mapBounded, CLI exit codes, MCP parity. Plans use
// preview output mode (renders land on <out>.preview.mp4, ultrafast) on tiny
// fixtures so the suite stays fast.
// T23 — overall-batch progress aggregation: the pure per-index fraction
// aggregator (fake plans/fractions, no renders) + the renderBatch-level
// no-sink no-op lock.
// T26 — the formatted per-plan `message` on every aggregate event: FIXED
// template `plan i/N (basename): P% — overall O%` (basename display name,
// completion → 100, Math.round integers, single-plan shape, determinism).

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

// --------------------------------------------- T23: overall progress aggregation

const round3 = (v: number): number => Math.round(v * 1000) / 1000;

test("aggregator: overall = (Σ per-plan fractions)/N × 100 with out-of-order completion (parallel interleaving)", () => {
  const out: BatchProgressEvent[] = [];
  const agg = createBatchProgressAggregator(
    ["plans/alpha.json", "plans/beta.json", "plans/gamma.json"],
    (p) => out.push(p),
  );
  agg.planEvent(1, { percent: 30, timeSec: 1 }); // (0 + .3 + 0)/3 → 10
  agg.planEvent(2, { percent: 60, timeSec: 2 }); // (0 + .3 + .6)/3 → 30
  agg.planComplete(2); // plan 2 finishes FIRST (out of order) → 43.333…
  agg.planEvent(0, { percent: 50, timeSec: 0.5 }); // → 60
  agg.planEvent(1, { percent: 90, timeSec: 3 }); // → 80
  agg.planComplete(0); // → 96.666…
  agg.planComplete(1); // the LAST completion drives overall to EXACTLY 100
  assert.deepEqual(
    out.map((p) => round3(p.percent)),
    [10, 30, 43.333, 60, 80, 96.667, 100],
  );
  // timeSec = the TRIGGERING plan's own engine time (sink message names it)
  assert.deepEqual(out.map((p) => p.timeSec), [1, 2, 2, 0.5, 3, 0.5, 3]);
});

test("aggregator: completion LOCKS at fraction 1 — success or captured failure, even having never rendered", () => {
  const out: BatchProgressEvent[] = [];
  const agg = createBatchProgressAggregator(["d/a.json", "d/b.json"], (p) => out.push(p));
  agg.planComplete(0); // e.g. PLAN_INVALID_JSON — no engine event ever, still finished
  agg.planEvent(1, { percent: 40, timeSec: 5 }); // in-flight plan fails right after…
  agg.planComplete(1); // …and still locks at 1 (a finished plan is finished)
  assert.deepEqual(
    out.map((p) => round3(p.percent)),
    [50, 70, 100],
  );
  assert.deepEqual(out.map((p) => p.timeSec), [0, 5, 5]); // never-rendered plan carries its 0 default
});

test("aggregator: percent === null engine events are skipped (R6) — no emit, no fraction change", () => {
  const out: BatchProgressEvent[] = [];
  const agg = createBatchProgressAggregator(["n1.json", "n2.json"], (p) => out.push(p));
  agg.planEvent(0, { percent: null, timeSec: 1 }); // skipped
  agg.planEvent(0, { percent: 25, timeSec: 2 }); // accepted → 12.5
  agg.planEvent(0, { percent: null, timeSec: 3 }); // skipped again
  agg.planComplete(1);
  assert.deepEqual(
    out.map((p) => round3(p.percent)),
    [12.5, 62.5],
  ); // the null events contributed nothing: (0.25 + 1)/2 = 62.5
});

test("aggregator: single-plan batch degrades to exactly video_render's raw stream (parity)", () => {
  const out: BatchProgressEvent[] = [];
  const agg = createBatchProgressAggregator(["solo.json"], (p) => out.push(p));
  const stream = [
    { percent: 0.9, timeSec: 0.2 },
    { percent: 2.0, timeSec: 0.4 },
    { percent: 50, timeSec: 10 },
    { percent: 51, timeSec: 10.2 },
    { percent: 100, timeSec: 20 },
  ];
  for (const e of stream) agg.planEvent(0, e);
  // exact passthrough: fraction = percent/100, so overall = percent (the ×100
  // round-trip can leave a 1-ulp float artifact — compared at 1e-6)
  const r6 = (v: number): number => Math.round(v * 1e6) / 1e6;
  assert.deepEqual(
    out.map((p) => r6(p.percent)),
    stream.map((e) => r6(e.percent)),
  );
  assert.deepEqual(out.map((p) => p.timeSec), stream.map((e) => e.timeSec));
  agg.planComplete(0); // natural terminal event at the SAME 100 — a sink's
  // ≥1.0-point gate suppresses it (Δ = 0), so video_render parity holds end
  // to end; no synthetic final event is invented
  assert.deepEqual(
    out.map((p) => r6(p.percent)),
    [...stream.map((e) => r6(e.percent)), 100],
  );
  // defensive clamp: the fraction can never exceed 1 (overall ≤ total:100)
  const clamped: BatchProgressEvent[] = [];
  createBatchProgressAggregator(["c1.json", "c2.json"], (p) => clamped.push(p)).planEvent(0, {
    percent: 150,
    timeSec: 1,
  });
  assert.equal(round3(clamped[0]!.percent), 50); // 1.0 + 0 contributions / 2, never 75
});

test("aggregator: deterministic — the same synthetic streams yield the same overall sequence", () => {
  const feed = (agg: ReturnType<typeof createBatchProgressAggregator>): void => {
    agg.planEvent(0, { percent: 10, timeSec: 1 });
    agg.planEvent(3, { percent: 33, timeSec: 2 });
    agg.planEvent(1, { percent: null, timeSec: 9 });
    agg.planComplete(3);
    agg.planEvent(2, { percent: 99.5, timeSec: 3 });
    agg.planComplete(0);
    agg.planComplete(2);
    agg.planEvent(1, { percent: 20, timeSec: 4 });
    agg.planComplete(1);
  };
  const a: BatchProgressEvent[] = [];
  const b: BatchProgressEvent[] = [];
  feed(createBatchProgressAggregator(["f1.json", "f2.json", "f3.json", "f4.json"], (p) => a.push(p)));
  feed(createBatchProgressAggregator(["f1.json", "f2.json", "f3.json", "f4.json"], (p) => b.push(p)));
  assert.deepEqual(a, b);
  assert.equal(a[a.length - 1]!.percent, 100); // ends at exactly 100, no clock involved
});

// --------------------------------------------- T26: the formatted message field

test("message: FIXED template `plan i/N (basename): P% — overall O%` — mid-flight, completion → 100, basename, rounding", () => {
  const out: BatchProgressEvent[] = [];
  const agg = createBatchProgressAggregator(
    ["plans/alpha.json", "plans/beta.json", "plans/gamma.json"],
    (p) => out.push(p),
  );
  agg.planEvent(1, { percent: 33.4, timeSec: 2 }); // 0-based idx 1 → plan 2/3; 33.4 → 33; overall 11.13… → 11
  agg.planComplete(2); // completion: P LOCKED at 100; overall (0.334+1)/3 → 44.47 → 44
  agg.planEvent(1, { percent: 90, timeSec: 3 }); // → 63.33 → 63
  agg.planComplete(0); // → 96.67 → 97 (round UP branch)
  agg.planComplete(1); // the LAST completion: overall exactly 100
  assert.deepEqual(out.map((p) => p.message), [
    "plan 2/3 (beta.json): 33% — overall 11%",
    "plan 3/3 (gamma.json): 100% — overall 44%",
    "plan 2/3 (beta.json): 90% — overall 63%",
    "plan 1/3 (alpha.json): 100% — overall 97%",
    "plan 2/3 (beta.json): 100% — overall 100%",
  ]);
});

test("message: single-plan batch keeps the template (i/N = 1/1, overall ≡ planPct, half-up rounding)", () => {
  const out: BatchProgressEvent[] = [];
  const agg = createBatchProgressAggregator(["solo/only-one.json"], (p) => out.push(p));
  agg.planEvent(0, { percent: 45.5, timeSec: 1 }); // Math.round(45.5) = 46 — the half branch
  agg.planComplete(0);
  assert.deepEqual(out.map((p) => p.message), [
    "plan 1/1 (only-one.json): 46% — overall 46%",
    "plan 1/1 (only-one.json): 100% — overall 100%",
  ]);
});

test("message: a never-rendered plan's completion still reads its OWN 100 (failure locks at 1)", () => {
  const out: BatchProgressEvent[] = [];
  createBatchProgressAggregator(["d/a.json", "d/b.json"], (p) => out.push(p)).planComplete(0);
  assert.deepEqual(out.map((p) => p.message), ["plan 1/2 (a.json): 100% — overall 50%"]);
});

test("message: deterministic — the same synthetic sequence yields byte-identical messages", () => {
  const feed = (agg: ReturnType<typeof createBatchProgressAggregator>): void => {
    agg.planEvent(0, { percent: 10.4, timeSec: 1 });
    agg.planEvent(2, { percent: 33, timeSec: 2 });
    agg.planComplete(2);
    agg.planEvent(1, { percent: null, timeSec: 9 });
    agg.planComplete(0);
    agg.planEvent(1, { percent: 99.6, timeSec: 3 }); // 99.6 → 100 by rounding, fraction stays 0.996
    agg.planComplete(1);
  };
  const a: BatchProgressEvent[] = [];
  const b: BatchProgressEvent[] = [];
  feed(createBatchProgressAggregator(["p/q1.json", "q2.json", "r/q3.json"], (p) => a.push(p)));
  feed(createBatchProgressAggregator(["p/q1.json", "q2.json", "r/q3.json"], (p) => b.push(p)));
  assert.deepEqual(a, b); // FULL events — percent AND message byte-identical
  for (const e of a) assert.match(e.message, /^plan [1-3]\/3 \((q1|q2|q3)\.json\): \d+% — overall \d+%$/);
  assert.equal(a[a.length - 1]!.message, "plan 2/3 (q2.json): 100% — overall 100%");
});

function stripWallMs(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripWallMs);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k === "wallMs") continue;
      out[k] = stripWallMs(val);
    }
    return out;
  }
  return v;
}

test("render-batch: onProgress is a pure addition — sink vs no-sink BatchReports identical (modulo wallMs), CLI/stdio keep the no-sink path", async () => {
  const p1 = await writePlan("np1.json", plan(FIXTURE, [{ type: "trim", start: 0, end: 0.4 }], "np1.mp4"));
  const p2 = await writePlan("np2.json", plan(FIXTURE, [{ type: "trim", start: 0.4, end: 0.8 }], "np2.mp4"));
  const events: BatchProgressEvent[] = [];
  const withSink = await renderBatch([p1, p2], { jobs: 1, force: true, onProgress: (p) => events.push(p as BatchProgressEvent) });
  const withoutSink = await renderBatch([p1, p2], { jobs: 1, force: true });
  assert.equal(withSink.summary.rendered, 2);
  assert.deepEqual(stripWallMs(withSink), stripWallMs(withoutSink));

  // the raw overall stream: percent always within the 0–100 total domain and
  // the LAST event exactly 100 (the final completion — no synthetic event;
  // ≥2 is structural: each plan completion forwards, and there are 2 plans);
  // values are RAW (a within-plan engine regression may dip them — the
  // transport sink's monotonic gate is the fence, not the aggregator's)
  assert.ok(events.length >= 2, `expected >=2 raw overall events, got ${events.length}`);
  for (const e of events) assert.ok(e.percent >= 0 && e.percent <= 100);
  assert.equal(round3(events[events.length - 1]!.percent), 100);

  // (T26) real renders through the aggregator: every event's message is the
  // FIXED template naming the in-flight plan by BASENAME; jobs=1 runs plan 1
  // to completion before plan 2, so the terminal message is deterministic
  for (const e of events) {
    const m = /^plan ([12])\/2 \((np1|np2)\.json\): (\d+)% — overall (\d+)%$/.exec(e.message);
    assert.ok(m, `message not in template: ${JSON.stringify(e.message)}`);
    assert.ok(Number(m[3]) <= 100 && Number(m[4]) <= 100);
  }
  assert.equal(events[events.length - 1]!.message, "plan 2/2 (np2.json): 100% — overall 100%");
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
