import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { inspectFile, runCapture } from "../media/ffprobe.js";
import { validatePlan } from "../validate/validate.js";
import { renderPlan } from "../render/render.js";
import { ToolError } from "../core/errors.js";

const FIXTURE = "fixture.mp4";
let dir = "";

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "video-toolkit-test-"));
  process.chdir(dir);
  const r = await runCapture("ffmpeg", [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30",
    "-f", "lavfi", "-i", "sine=frequency=440",
    "-t", "12", "-c:v", "libx264", "-crf", "23", "-pix_fmt", "yuv420p",
    "-c:a", "aac", FIXTURE,
  ]);
  assert.equal(r.code, 0, r.stderr);
});

after(async () => {
  process.chdir(tmpdir());
  await rm(dir, { recursive: true, force: true });
});

function plan(operations: unknown[], output = "out.mp4"): unknown {
  return { version: 1, source: FIXTURE, operations, output: { path: output } };
}

async function writePlan(name: string, p: unknown): Promise<string> {
  await writeFile(name, JSON.stringify(p));
  return name;
}

test("inspect returns structured metadata", async () => {
  const info = await inspectFile(FIXTURE);
  assert.ok(Math.abs(info.duration - 12) < 0.2);
  assert.equal(info.video?.width, 1280);
  assert.equal(info.video?.height, 720);
  assert.equal(info.audio?.sampleRate, 44100);
});

test("whole-source plan validates", async () => {
  const p = await writePlan("p0.json", plan([{ type: "trim", start: 0, end: 12 }]));
  const r = await validatePlan(p);
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.ok(Math.abs((r.timelineDuration ?? 0) - 12) < 0.01);
});

test("trim 2-10 renders 8s", async () => {
  const p = await writePlan("p1.json", plan([{ type: "trim", start: 2, end: 10 }], "r1.mp4"));
  const r = await renderPlan(p);
  assert.ok(Math.abs(r.outputDuration - 8) < 0.3, `got ${r.outputDuration}`);
});

test("cut removes an interior range: 12 - 2 = 10s", async () => {
  const p = await writePlan("p2.json", plan([
    { type: "trim", start: 0, end: 12 },
    { type: "cut", start: 3, end: 5 },
  ], "r2.mp4"));
  const r = await renderPlan(p);
  assert.ok(Math.abs(r.outputDuration - 10) < 0.3, `got ${r.outputDuration}`);
});

test("two trims imply concat: 4 + 4 = 8s", async () => {
  const p = await writePlan("p3.json", plan([
    { type: "trim", start: 0, end: 4 },
    { type: "trim", start: 8, end: 12 },
  ], "r3.mp4"));
  const r = await renderPlan(p);
  assert.ok(Math.abs(r.outputDuration - 8) < 0.3, `got ${r.outputDuration}`);
  assert.equal(r.timelineSegments, 2);
});

test("normalize-audio renders", async () => {
  const p = await writePlan("p4.json", plan([
    { type: "trim", start: 0, end: 6 },
    { type: "normalize-audio" },
  ], "r4.mp4"));
  const r = await renderPlan(p);
  assert.ok(Math.abs(r.outputDuration - 6) < 0.3, `got ${r.outputDuration}`);
});

test("preview writes <stem>.preview.mp4 at reduced width", async () => {
  const p = await writePlan("p5.json", plan([{ type: "trim", start: 0, end: 6 }], "r5.mp4"));
  const r = await renderPlan(p, { mode: "preview" });
  assert.ok(r.output.endsWith("r5.preview.mp4"), r.output);
  const info = await inspectFile(r.output);
  assert.equal(info.video?.width, 640);
});

test("every non-mix render path is ONE ffmpeg invocation (INVARIANT 1)", async () => {
  const oneInvocation = (r: { command: string[] }, inputs: number) => {
    assert.equal(r.command[0], "ffmpeg");
    assert.equal(r.command.filter((a) => a === "-i").length, inputs);
    assert.equal(r.command.includes("-shortest"), false);
    assert.equal(r.command.includes("-t"), false);
  };

  // plain timeline (no transforms): legacy -af audio chain, single input
  const plain = await renderPlan(await writePlan("one1.json", plan([
    { type: "trim", start: 0, end: 4 },
    { type: "cut", start: 1, end: 2 },
  ], "one1.mp4")));
  oneInvocation(plain, 1);
  assert.ok(plain.command.includes("-af"));
  assert.equal(plain.command.includes("-filter_complex"), false);

  // transforms + burned captions composition: still one invocation, one input
  await writeFile("one.srt", "1\n00:00:00,000 --> 00:00:02,000\none pass\n");
  const composed = await renderPlan(await writePlan("one2.json", plan([
    { type: "trim", start: 0, end: 6 },
    { type: "speed", factor: 2 },
    { type: "resize", width: 640 },
    { type: "volume", db: -3 },
    { type: "normalize-audio" },
    { type: "captions", file: "one.srt" },
  ], "one2.mp4")));
  oneInvocation(composed, 1);
  assert.ok(composed.command.join(" ").includes("subtitles="));

  // preview mode honors the same single-pass contract
  const prev = await renderPlan(
    await writePlan("one3.json", plan([{ type: "trim", start: 0, end: 4 }], "one3.mp4")),
    { mode: "preview" },
  );
  oneInvocation(prev, 1);
});

test("out-of-range timestamp -> TIMESTAMP_OUT_OF_RANGE with operation index", async () => {
  const p = await writePlan("e1.json", plan([{ type: "trim", start: 0, end: 100 }]));
  const r = await validatePlan(p);
  assert.equal(r.valid, false);
  assert.equal(r.errors[0]?.code, "TIMESTAMP_OUT_OF_RANGE");
  assert.equal(r.errors[0]?.operation, 1);
});

test("reversed range -> RANGE_NEGATIVE", async () => {
  const p = await writePlan("e2.json", plan([{ type: "trim", start: 9, end: 3 }]));
  const r = await validatePlan(p);
  assert.equal(r.errors[0]?.code, "RANGE_NEGATIVE");
});

test("cutting everything -> EMPTY_TIMELINE", async () => {
  const p = await writePlan("e3.json", plan([{ type: "cut", start: 0, end: 12 }]));
  const r = await validatePlan(p);
  assert.equal(r.errors[0]?.code, "EMPTY_TIMELINE");
});

test("output pointing at the source -> error", async () => {
  const p = await writePlan("e4.json", plan([{ type: "trim", start: 0, end: 5 }], FIXTURE));
  const r = await validatePlan(p);
  assert.equal(r.errors[0]?.code, "OUTPUT_WOULD_OVERWRITE_SOURCE");
});

test("schema-invalid plan -> render throws ToolError with issues", async () => {
  await writeFile("e5.json", JSON.stringify({ version: 2, source: FIXTURE, operations: [], output: { path: "x.mp4" } }));
  await assert.rejects(
    () => renderPlan("e5.json"),
    (e: unknown) => e instanceof ToolError && e.code === "PLAN_SCHEMA_INVALID",
  );
});

test("render refuses to overwrite without --force, honors force", async () => {
  const p = await writePlan("p6.json", plan([{ type: "trim", start: 0, end: 3 }], "r6.mp4"));
  await renderPlan(p);
  await assert.rejects(
    () => renderPlan(p),
    (e: unknown) => e instanceof ToolError && e.code === "OUTPUT_EXISTS",
  );
  await renderPlan(p, { force: true });
});

test("CLI bin: video inspect emits compact JSON on stdout", async () => {
  const bin = path.resolve(import.meta.dirname, "..", "cli", "index.js");
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [bin, "inspect", FIXTURE], {
      cwd: process.cwd(),
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d));
    child.stderr.on("data", (d: Buffer) => (err += d));
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(err))));
  });
  const parsed = JSON.parse(stdout) as { duration: number; video?: { width: number } };
  assert.ok(Math.abs(parsed.duration - 12) < 0.2);
  assert.equal(parsed.video?.width, 1280);
});
