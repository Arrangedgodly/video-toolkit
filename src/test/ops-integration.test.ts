import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCapture, inspectFile } from "../media/ffprobe.js";
import { validatePlan } from "../validate/validate.js";
import { renderPlan } from "../render/render.js";

const FIXTURE = "fixture.mp4"; // 12s, 1280x720, 440Hz tone
const SPEECH = "speech-gated.mp4"; // 12s, 3kHz bursts: 2.5s on / 1.5s off
const BED = "bed.mp3"; // 5s, 200Hz stereo 48kHz mp3 (shorter + rate/layout-mismatched)
const NOAUDIO = "noaudio.mp4"; // 3s video-only
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

  // gated speech: 3 kHz tone bursts (ducking key) — mirrors the R1 spike fixture
  const r2 = await runCapture("ffmpeg", [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25",
    "-f", "lavfi", "-i", "aevalsrc=0.5*sin(3000*2*PI*t)*lt(mod(t\\,4)\\,2.5):s=44100",
    "-t", "12", "-c:v", "libx264", "-crf", "23", "-pix_fmt", "yuv420p",
    "-c:a", "aac", SPEECH,
  ]);
  assert.equal(r2.code, 0, r2.stderr);

  // music bed: far from 3 kHz so a lowpass probe can isolate it
  const r3 = await runCapture("ffmpeg", [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "aevalsrc=0.25*sin(200*2*PI*t):c=stereo:s=48000:d=5",
    "-c:a", "libmp3lame", "-b:a", "128k", BED,
  ]);
  assert.equal(r3.code, 0, r3.stderr);

  const r4 = await runCapture("ffmpeg", [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25",
    "-t", "3", "-c:v", "libx264", "-crf", "30", "-pix_fmt", "yuv420p", "-an", NOAUDIO,
  ]);
  assert.equal(r4.code, 0, r4.stderr);
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

test("speed 2x render emits no verify warning (comparison is speed-adjusted)", async () => {
  // 12s whole-source at 2x: output must be ~6s = timeline/speed — a CORRECT
  // render whose raw-timeline delta exceeds the 1.0s warning threshold, i.e.
  // exactly the case that used to fire the spurious "differs from timeline"
  // warning when the verify stage compared against the RAW timelineDuration
  const p = await writePlan("t1verify.json", plan([
    { type: "trim", start: 0, end: 12 },
    { type: "speed", factor: 2 },
  ], "t1verify.mp4"));
  const debugLines: string[] = [];
  const r = await renderPlan(p, { debug: (line) => debugLines.push(line) });
  assert.ok(Math.abs(r.outputDuration - 6) < 0.3, `duration ${r.outputDuration}`);
  // load-bearing: the raw-timeline delta is beyond the threshold, so a revert
  // to comparing against timelineDuration would re-emit the warning
  assert.ok(
    r.timelineDuration - r.outputDuration > 1.0,
    `raw-timeline delta ${r.timelineDuration - r.outputDuration} must exceed the 1.0s threshold`,
  );
  assert.ok(
    debugLines.every((l) => !l.includes("warning: output duration")),
    `unexpected verify warning: ${debugLines.join(" | ")}`,
  );
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

// ---- audio-mix (single-pass ducking; measurement mirrors the R1 spike)

/** volumedetect mean over an output window, optionally through probe filters
 * (lowpass isolates the 200 Hz bed from the 3 kHz speech). */
async function meanVolumeDb(file: string, ss: number, dur: number, filters = ""): Promise<number> {
  const r = await runCapture("ffmpeg", [
    "-nostdin", "-hide_banner",
    "-ss", String(ss), "-t", String(dur), "-i", file,
    "-af", filters ? `${filters},volumedetect` : "volumedetect",
    "-f", "null", "-",
  ]);
  assert.equal(r.code, 0, r.stderr);
  const m = /mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/.exec(r.stderr);
  assert.ok(m, r.stderr);
  return Number(m[1]);
}

test("audio-mix renders one pass; ducking measurably modulates the bed", async () => {
  // gated speech 0-8s: tone ON [0,2.5), OFF [2.5,4), ON [4,6.5), OFF [6.5,8)
  const p = await writePlan("m1.json", {
    version: 1,
    source: SPEECH,
    operations: [
      { type: "trim", start: 0, end: 8 },
      { type: "audio-mix", file: BED, level: -18, duck: { threshold: 0.02, ratio: 8, attack: 20, release: 400 } },
    ],
    output: { path: "m1.mp4" },
  });
  const v = await validatePlan(p);
  assert.equal(v.valid, true, JSON.stringify(v.errors));
  assert.ok(Math.abs((v.timelineDuration ?? 0) - 8) < 0.01);

  const r = await renderPlan(p);
  // INVARIANT 1: exactly ONE ffmpeg invocation carrying video, mix, ducking
  assert.equal(r.command[0], "ffmpeg");
  assert.equal(r.command.filter((a) => a === "-i").length, 2, "source + bed inputs");
  assert.ok(r.command.includes("-filter_complex"));
  assert.ok(r.command.includes("-stream_loop"));
  assert.equal(r.command.includes("-af"), false);
  assert.equal(r.command.includes("-shortest"), false);
  assert.equal(r.command.includes("-t"), false);

  // duration == timeline duration (video CFR rounding + one AAC frame)
  assert.ok(Math.abs(r.outputDuration - 8) < 0.3, `duration ${r.outputDuration}`);
  const info = await inspectFile(r.output);
  assert.ok(info.audio, "mixed audio stream present");

  // ducking modulates (bed isolated from the 3 kHz speech by a lowpass probe):
  // speech-ON window -> bed compressed; speech-OFF window -> bed at level
  const onBed = await meanVolumeDb(r.output, 0.1, 2.2, "lowpass=f=600,lowpass=f=600");
  const offBed = await meanVolumeDb(r.output, 3.1, 0.7, "lowpass=f=600,lowpass=f=600");
  assert.ok(offBed > -45, `bed present unducked in the silence window: ${offBed} dB`);
  assert.ok(offBed - onBed > 8, `expected duck depth > 8 dB, on ${onBed} dB vs off ${offBed} dB`);

  // the speech itself passes through the mix at its own level
  const onFull = await meanVolumeDb(r.output, 0.1, 2.2);
  const offFull = await meanVolumeDb(r.output, 3.1, 0.7);
  assert.ok(onFull - offFull > 10, `speech dominates the ON window: ${onFull} vs ${offFull}`);
});

test("audio-mix with a missing bed -> MIX_INPUT_NOT_FOUND (validate + render)", async () => {
  const p = await writePlan("m2.json", plan([
    { type: "trim", start: 0, end: 4 },
    { type: "audio-mix", file: "missing-bed.mp3" },
  ], "m2.mp4"));
  const r = await validatePlan(p);
  assert.equal(r.valid, false);
  assert.equal(r.errors[0]?.code, "MIX_INPUT_NOT_FOUND");
  assert.equal(r.errors[0]?.operation, 2);
  await assert.rejects(
    () => renderPlan(p),
    (e: unknown) => (e as { code?: string }).code === "MIX_INPUT_NOT_FOUND",
  );
});

test("duplicate audio-mix -> OPERATION_INVALID with indices", async () => {
  const p = await writePlan("m3.json", plan([
    { type: "audio-mix", file: BED },
    { type: "audio-mix", file: BED },
  ]));
  const r = await validatePlan(p);
  assert.equal(r.valid, false);
  assert.equal(r.errors[0]?.code, "OPERATION_INVALID");
  assert.equal(r.errors[0]?.operation, 2);
});

test("audio-mix on an audio-less source warns (NO_AUDIO_STREAM), renders without the mix", async () => {
  const p = await writePlan("m4.json", {
    version: 1,
    source: NOAUDIO,
    operations: [{ type: "trim", start: 0, end: 3 }, { type: "audio-mix", file: BED }],
    output: { path: "m4.mp4" },
  });
  const v = await validatePlan(p);
  assert.equal(v.valid, true, JSON.stringify(v.errors));
  assert.ok(v.warnings.some((w) => w.code === "NO_AUDIO_STREAM"), JSON.stringify(v.warnings));
  const r = await renderPlan(p);
  assert.ok(Math.abs(r.outputDuration - 3) < 0.3);
  assert.equal(r.command.includes("-filter_complex"), false);
  assert.equal(r.command.includes("-stream_loop"), false);
  assert.equal(r.command.filter((a) => a === "-i").length, 1); // no bed input
  assert.ok(r.command.includes("-an"));
});

test("preview honors audio-mix identically (same graph, preview settings, op defaults)", async () => {
  const p = await writePlan("m5.json", plan([
    { type: "trim", start: 0, end: 4 },
    { type: "audio-mix", file: BED }, // defaults: level -18, duck 0.02/8/20/400
  ], "m5.mp4"));
  const r = await renderPlan(p, { mode: "preview" });
  assert.ok(r.output.endsWith("m5.preview.mp4"), r.output);
  assert.ok(r.command.includes("-filter_complex"));
  assert.ok(r.command.includes("-stream_loop"));
  const graph = r.command[r.command.indexOf("-filter_complex") + 1]!;
  assert.ok(graph.includes("volume=-18dB"), graph);
  assert.ok(graph.includes("threshold=0.02:ratio=8:attack=20:release=400"), graph);
  const bIdx = r.command.indexOf("-b:a");
  assert.equal(r.command[bIdx + 1], "96k"); // preview audio bitrate
  assert.ok(Math.abs(r.outputDuration - 4) < 0.3);
});
