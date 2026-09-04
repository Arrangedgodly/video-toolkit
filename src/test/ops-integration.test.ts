import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCapture, inspectFile } from "../media/ffprobe.js";
import { validatePlan } from "../validate/validate.js";
import { renderPlan } from "../render/render.js";

const FIXTURE = "fixture.mp4"; // 12s, 1280x720, 440Hz tone
let dir = "";

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "video-toolkit-m3-"));
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

test("timeline + speed 2 + resize + volume renders in one pass", async () => {
  // keep 0-12 minus 3-5 = 10s, at 2x = 5s, at 640w
  const p = await writePlan("t1.json", plan([
    { type: "trim", start: 0, end: 12 },
    { type: "cut", start: 3, end: 5 },
    { type: "speed", factor: 2 },
    { type: "resize", width: 640 },
    { type: "volume", db: -6 },
  ], "t1.mp4"));

  const v = await validatePlan(p);
  assert.equal(v.valid, true, JSON.stringify(v.errors));
  assert.ok(Math.abs((v.timelineDuration ?? 0) - 10) < 0.01);

  const r = await renderPlan(p);
  assert.ok(Math.abs(r.outputDuration - 5) < 0.3, `duration ${r.outputDuration}`);
  const info = await inspectFile(r.output);
  assert.equal(info.video?.width, 640);
  const cmd = r.command.join(" ");
  assert.ok(cmd.includes("atempo=2"), cmd);
  assert.ok(cmd.includes("volume=-6dB"), cmd);
  assert.ok(cmd.includes("scale=640:-2"), cmd);
});

test("preview of a resize plan stays at the smaller width", async () => {
  const p = await writePlan("t2.json", plan([
    { type: "trim", start: 0, end: 6 },
    { type: "resize", width: 960 },
  ], "t2.mp4"));
  const r = await renderPlan(p, { mode: "preview" });
  const info = await inspectFile(r.output);
  assert.equal(info.video?.width, 640); // min(960, preview 640)
});

test("exact resize honors height", async () => {
  const p = await writePlan("t3.json", plan([
    { type: "trim", start: 0, end: 4 },
    { type: "resize", width: 800, height: 600 },
  ], "t3.mp4"));
  const r = await renderPlan(p);
  const info = await inspectFile(r.output);
  assert.equal(info.video?.width, 800);
  assert.equal(info.video?.height, 600);
});

test("duplicate transform op -> OPERATION_INVALID with indices", async () => {
  const p = await writePlan("e1.json", plan([
    { type: "speed", factor: 2 },
    { type: "speed", factor: 3 },
  ]));
  const r = await validatePlan(p);
  assert.equal(r.valid, false);
  assert.equal(r.errors[0]?.code, "OPERATION_INVALID");
  assert.equal(r.errors[0]?.operation, 2);
});

test("volume with both or neither param -> OPERATION_INVALID", async () => {
  const both = await validatePlan(await writePlan("e2.json", plan([
    { type: "volume", db: -6, factor: 2 },
  ])));
  assert.equal(both.errors[0]?.code, "OPERATION_INVALID");

  const neither = await validatePlan(await writePlan("e3.json", plan([
    { type: "volume" },
  ])));
  assert.equal(neither.errors[0]?.code, "OPERATION_INVALID");
});

test("render of an invalid transform plan throws with the code", async () => {
  const p = await writePlan("e4.json", plan([{ type: "speed", factor: 2 }, { type: "speed", factor: 2 }], "nope.mp4"));
  await assert.rejects(
    () => renderPlan(p),
    (e: unknown) => (e as { code?: string }).code === "OPERATION_INVALID",
  );
});
