import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCapture, inspectFile } from "../media/ffprobe.js";
import { validatePlan } from "../validate/validate.js";
import { renderPlan } from "../render/render.js";
import { generateCaptions } from "../captions/generate.js";
import { CROSSFADE_KINDS } from "../core/schemas.js";

const FIXTURE = "fixture.mp4"; // 12s, 1280x720, 440Hz tone
const SPEECH = "speech-gated.mp4"; // 12s, 3kHz bursts: 2.5s on / 1.5s off
const BED = "bed.mp3"; // 5s, 200Hz stereo 48kHz mp3 (shorter + rate/layout-mismatched)
const NOAUDIO = "noaudio.mp4"; // 3s video-only
const BLACK = "black.mp4"; // 2s solid black, video-only — overlay visibility probe
const BLOCKS = "blocks.mp4"; // 15s, 640x360@30: red[0,5)+440Hz, green[5,10)+880Hz,
//                            blue[10,15)+1320Hz — R3's transition fixture shape
const XFK = "xfk.mp4"; // 2.6s, 320x180@25: red[0,1.3)+440Hz, green[1.3,2.6)+880Hz
//                      — T17's tiny kind-sweep fixture (2 keep-segments via a cut)
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

  // solid black: burned text is the ONLY source of luminance in a decoded frame
  const r5 = await runCapture("ffmpeg", [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=black:s=640x360:rate=25",
    "-t", "2", "-c:v", "libx264", "-crf", "30", "-pix_fmt", "yuv420p", "-an", BLACK,
  ]);
  assert.equal(r5.code, 0, r5.stderr);

  // R3's transition fixture (docs/ultron/research/r3-xfade-single-pass.md):
  // three hard color blocks + per-block tones so every boundary is
  // measurable colorimetrically; keep [1,4]+[5.5,9]+[11,14.5] D=0.5 below
  const r6 = await runCapture("ffmpeg", [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=c=0xC00000:s=640x360:r=30:d=5",
    "-f", "lavfi", "-i", "color=c=0x00A000:s=640x360:r=30:d=5",
    "-f", "lavfi", "-i", "color=c=0x0000C0:s=640x360:r=30:d=5",
    "-f", "lavfi", "-i", "sine=f=440:r=44100:d=5",
    "-f", "lavfi", "-i", "sine=f=880:r=44100:d=5",
    "-f", "lavfi", "-i", "sine=f=1320:r=44100:d=5",
    "-filter_complex", "[0:v][3:a][1:v][4:a][2:v][5:a]concat=n=3:v=1:a=1[v][a]",
    "-map", "[v]", "-map", "[a]",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k", BLOCKS,
  ]);
  assert.equal(r6.code, 0, r6.stderr);

  // T17 sweep fixture: the SMALLEST honest crossfade source — 320x180@25 with
  // distinct tones. Keeps = trim[0,2.6] − cut[1.2,1.4] = two 1.2s segments
  // (ADJACENT trims would union into one — the cut enforces the gap); D=0.12
  // (3 frames, ≥ the 2-frame floor) → expected output 2.4 − 0.12 = 2.28s
  const r7 = await runCapture("ffmpeg", [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=c=0xC00000:s=320x180:r=25:d=1.3",
    "-f", "lavfi", "-i", "color=c=0x00A000:s=320x180:r=25:d=1.3",
    "-f", "lavfi", "-i", "sine=f=440:r=44100:d=1.3",
    "-f", "lavfi", "-i", "sine=f=880:r=44100:d=1.3",
    "-filter_complex", "[0:v][2:a][1:v][3:a]concat=n=2:v=1:a=1[v][a]",
    "-map", "[v]", "-map", "[a]",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k", XFK,
  ]);
  assert.equal(r7.code, 0, r7.stderr);
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

// ---- overlay-text (ONE drawtext burned in the same single pass)

/** brightest luma byte of a decoded frame — a text-presence probe on the
 * solid-black fixture (text on => >200; pure black => ~0 after the limited->
 * full-range gray conversion). */
async function maxLuma(file: string, t: number): Promise<number> {
  const r = await runCapture("ffmpeg", [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    "-ss", String(t), "-i", file,
    "-frames:v", "1", "-pix_fmt", "gray", "-f", "rawvideo", "luma.raw",
  ]);
  assert.equal(r.code, 0, r.stderr);
  const buf = await readFile("luma.raw");
  let m = 0;
  for (const b of buf) if (b > m) m = b;
  return m;
}

test("overlay-text burns in the same pass; visible only in its window; duration unchanged", async () => {
  // hostile text (apostrophe, colon, percent, comma) rides the real render —
  // the escaping unit tests pin the exact emitted filter string
  const p = await writePlan("o1.json", {
    version: 1,
    source: BLACK,
    operations: [
      { type: "trim", start: 0, end: 2 },
      { type: "overlay-text", text: "It's 100% done: part, two", from: 0.5, to: 1.5 },
    ],
    output: { path: "o1.mp4" },
  });
  const v = await validatePlan(p);
  assert.equal(v.valid, true, JSON.stringify(v.errors));

  const r = await renderPlan(p);
  // INVARIANT 1: exactly ONE ffmpeg invocation, one input, no complex graph
  assert.equal(r.command[0], "ffmpeg");
  assert.equal(r.command.filter((a) => a === "-i").length, 1);
  assert.equal(r.command.includes("-filter_complex"), false);
  const cmd = r.command.join(" ");
  assert.ok(cmd.includes("drawtext="), cmd);
  assert.ok(cmd.includes("enable='between(t,0.500,1.500)'"), cmd);
  assert.ok(cmd.includes("expansion=none"), cmd);
  assert.ok(cmd.includes("fontfile=/System/Library/Fonts/Helvetica.ttc"), cmd);

  // window semantics: text is the only luminance on solid black
  const inside = await maxLuma(r.output, 1.0);
  const outside = await maxLuma(r.output, 0.2);
  assert.ok(inside > 200, `text visible inside the window: max luma ${inside}`);
  assert.ok(outside < 40, `no text outside the window: max luma ${outside}`);

  // duration unchanged vs a no-overlay control; encodes differ (text on frames)
  assert.ok(Math.abs(r.outputDuration - 2) < 0.3, `duration ${r.outputDuration}`);
  const control = await writePlan("o1c.json", {
    version: 1,
    source: BLACK,
    operations: [{ type: "trim", start: 0, end: 2 }],
    output: { path: "o1c.mp4" },
  });
  const rc = await renderPlan(control);
  assert.ok(Math.abs(rc.outputDuration - r.outputDuration) < 0.05);
  const [a, b] = await Promise.all([readFile(r.output), readFile(rc.output)]);
  assert.ok(!a.equals(b), "overlay and control encodes are byte-identical");

  // preview parity: same drawtext, preview scale settings
  const pv = await renderPlan(p, { mode: "preview", force: true });
  assert.ok(pv.output.endsWith("o1.preview.mp4"), pv.output);
  const pvc = pv.command.join(" ");
  assert.ok(pvc.includes("drawtext="), pvc);
  assert.ok(pvc.includes("scale=640:-2"), pvc);
  assert.ok(Math.abs(pv.outputDuration - 2) < 0.3);
});

test("overlay-text validation: from<to, output-duration bounds (speed-aware), duplicates", async () => {
  // from >= to
  const r1 = await validatePlan(await writePlan("ov1.json", plan([
    { type: "trim", start: 0, end: 12 },
    { type: "overlay-text", text: "x", from: 3, to: 3 },
  ])));
  assert.equal(r1.valid, false);
  assert.equal(r1.errors[0]?.code, "RANGE_NEGATIVE");
  assert.equal(r1.errors[0]?.operation, 2);

  // to beyond the timeline (fixture is 12s)
  const r2 = await validatePlan(await writePlan("ov2.json", plan([
    { type: "trim", start: 0, end: 12 },
    { type: "overlay-text", text: "x", to: 13 },
  ])));
  assert.equal(r2.valid, false);
  assert.equal(r2.errors[0]?.code, "OPERATION_INVALID");
  assert.ok(r2.errors[0]?.message.includes("exceeds expected output duration"));

  // speed-aware bound: timeline 12 at 2x -> expected output 6s
  const r3 = await validatePlan(await writePlan("ov3.json", plan([
    { type: "trim", start: 0, end: 12 },
    { type: "speed", factor: 2 },
    { type: "overlay-text", text: "x", to: 6.5 },
  ])));
  assert.equal(r3.valid, false);
  assert.equal(r3.errors[0]?.code, "OPERATION_INVALID");
  const r4 = await validatePlan(await writePlan("ov4.json", plan([
    { type: "trim", start: 0, end: 12 },
    { type: "speed", factor: 2 },
    { type: "overlay-text", text: "x", to: 5.9 },
  ])));
  assert.equal(r4.valid, true, JSON.stringify(r4.errors));

  // duplicate op; render of it throws the code
  const r5 = await validatePlan(await writePlan("ov5.json", plan([
    { type: "trim", start: 0, end: 12 },
    { type: "overlay-text", text: "a" },
    { type: "overlay-text", text: "b" },
  ])));
  assert.equal(r5.valid, false);
  assert.equal(r5.errors[0]?.code, "OPERATION_INVALID");
  assert.equal(r5.errors[0]?.operation, 3);
  await assert.rejects(
    () => renderPlan("ov5.json"),
    (e: unknown) => (e as { code?: string }).code === "OPERATION_INVALID",
  );
});

// ---- crossfade (single-pass transition chain; measurements mirror the R3
// spike: keep [1,4]+[5.5,9]+[11,14.5] = 10.0s timeline, D=0.5 -> offsets
// 2.5/5.5, expected output 10.0 − 2·0.5 = 9.0s)

const XF_TRIMS = [
  { type: "trim", start: 1, end: 4 },
  { type: "trim", start: 5.5, end: 9 },
  { type: "trim", start: 11, end: 14.5 },
];

function xfPlan(ops: unknown[], output = "xf.mp4"): unknown {
  return { version: 1, source: BLOCKS, operations: ops, output: { path: output } };
}

/** mean luma byte of a decoded frame — the blend probe (pure blocks have
 * distinct stable means; a blend sits strictly between its neighbors). */
async function meanLuma(file: string, t: number): Promise<number> {
  const r = await runCapture("ffmpeg", [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    "-ss", String(t), "-i", file,
    "-frames:v", "1", "-pix_fmt", "gray", "-f", "rawvideo", "luma-mean.raw",
  ]);
  assert.equal(r.code, 0, r.stderr);
  const buf = await readFile("luma-mean.raw");
  let sum = 0;
  for (const b of buf) sum += b;
  return sum / buf.length;
}

test("crossfade: 3-segment render is ONE invocation; duration law frame-exact; both blends visible", async () => {
  const p = await writePlan("xf1.json", xfPlan([...XF_TRIMS, { type: "crossfade", duration: 0.5 }]));
  const v = await validatePlan(p);
  assert.equal(v.valid, true, JSON.stringify(v.errors));
  // validate surfaces the pre-fade timeline AND the adjusted expectation
  assert.ok(Math.abs((v.timelineDuration ?? 0) - 10) < 0.01);
  assert.equal(v.crossfadeDuration, 0.5);
  assert.ok(Math.abs((v.expectedDuration ?? 0) - 9.0) < 1e-9);

  const r = await renderPlan(p);
  // INVARIANT 1: exactly ONE ffmpeg invocation, 3 -i of the SAME source
  assert.equal(r.command[0], "ffmpeg");
  assert.equal(r.command.filter((a) => a === "-i").length, 3);
  assert.deepEqual(
    r.command.filter((_, i) => r.command[i - 1] === "-i"),
    [BLOCKS, BLOCKS, BLOCKS],
    "all three inputs are the same source (inputs only — never written)",
  );
  assert.ok(r.command.includes("-filter_complex"));
  assert.ok(r.command.join(" ").includes("xfade=transition=fade:duration=0.500:offset=2.500"));
  assert.ok(r.command.join(" ").includes("xfade=transition=fade:duration=0.500:offset=5.500"));
  assert.equal(r.command.includes("-vf"), false);
  assert.equal(r.command.includes("-af"), false);
  // no second pass, no select anywhere
  assert.equal(r.command.filter((a) => a === "-filter_complex").length, 1);
  assert.ok(!r.command.join(" ").includes("select="));

  // duration law: 10.0 − 2·0.5 = 9.0, frame-exact at 30 fps (R3 outB: 9.000/270f)
  assert.ok(Math.abs(r.outputDuration - 9.0) < 0.04, `duration ${r.outputDuration}`);

  // A/V both present
  const info = await inspectFile(r.output);
  assert.ok(info.video, "video stream present");
  assert.ok(info.audio, "audio stream present");

  // transitions visually evident at BOTH fade midpoints: the blend frame's
  // mean luma sits strictly between the two pure neighbors (and hence
  // differs from both) — fade 1 red->green over [2.5, 3.0], fade 2
  // green->blue over [5.5, 6.0]
  const red = await meanLuma(r.output, 1.0);
  const mid1 = await meanLuma(r.output, 2.75);
  const green = await meanLuma(r.output, 4.0);
  const mid2 = await meanLuma(r.output, 5.75);
  const blue = await meanLuma(r.output, 7.5);
  assert.ok(mid1 > red + 8 && mid1 < green - 8, `fade1 midpoint ${mid1} must sit between red ${red} and green ${green}`);
  assert.ok(mid2 > blue + 8 && mid2 < green - 8, `fade2 midpoint ${mid2} must sit between green ${green} and blue ${blue}`);
  // pure content is untouched outside the fade windows
  assert.ok(Math.abs(red - green) > 30 && Math.abs(green - blue) > 30, "blocks are colorimetrically distinct");
});

test("crossfade: speed composes AFTER the chain (duration = (timeline − shrinkage)/speed)", async () => {
  // 10.0 − 2·0.5 = 9.0, at 1.25x -> 7.2 (R3 outC: 7.233 measured, ≤1 frame)
  const p = await writePlan("xf2.json", xfPlan([
    ...XF_TRIMS,
    { type: "crossfade", duration: 0.5 },
    { type: "speed", factor: 1.25 },
  ], "xf2.mp4"));
  const v = await validatePlan(p);
  assert.equal(v.valid, true, JSON.stringify(v.errors));
  const r = await renderPlan(p);
  const cmd = r.command.join(" ");
  assert.ok(cmd.includes("setpts=PTS/1.25"), cmd); // NOT N/FRAME_RATE/TB
  assert.ok(cmd.includes("atempo=1.25"), cmd);
  assert.ok(Math.abs(r.outputDuration - 7.2) < 0.05, `duration ${r.outputDuration}`);
});

test("crossfade: burned captions align to the REMAPPED anchors (outcome (a), not the drifting plain ones)", async () => {
  // 1) generate the output-timed srt through the real captions pipeline with
  // the crossfade plan — the remap must shift seg-2 cues by −D and seg-3
  // cues by −2D
  const planPath = await writePlan("xf3-plan.json", xfPlan([
    ...XF_TRIMS,
    { type: "crossfade", duration: 0.5 },
  ], "xf3.mp4"));
  await writeFile("xf3-transcript.json", JSON.stringify({
    segments: [
      { start: 6.0, end: 8.0, text: "SECOND SEGMENT" },   // plain [3.5,5.5] -> [3.0,5.0]
      { start: 11.5, end: 13.5, text: "THIRD SEGMENT" },  // plain [7.0,9.0] -> [6.0,8.0]
    ],
  }));
  const cap = await generateCaptions("xf3-transcript.json", { plan: planPath, output: "xf3.srt" });
  assert.equal(cap.remapped, true);
  assert.equal(cap.cues, 2);
  const srt = await readFile("xf3.srt", "utf8");
  assert.ok(srt.includes("00:00:03,000 --> 00:00:05,000"), srt);
  assert.ok(srt.includes("00:00:06,000 --> 00:00:08,000"), srt);

  // 2) burn it in the same single pass (subtitles AFTER the chain per R3)
  const p = await writePlan("xf3.json", xfPlan([
    ...XF_TRIMS,
    { type: "crossfade", duration: 0.5 },
    { type: "captions", file: "xf3.srt", style: "FontSize=54" },
  ], "xf3.mp4"));
  const v = await validatePlan(p);
  assert.equal(v.valid, true, JSON.stringify(v.errors));
  const r = await renderPlan(p);
  assert.equal(r.command.filter((a) => a === "-i").length, 3, "still 3 inputs, one invocation");
  const graph = r.command[r.command.indexOf("-filter_complex") + 1]!;
  assert.ok(graph.indexOf("subtitles=") > graph.indexOf("offset=5.500"), "subtitles after the chain");

  // 3) honesty probe: white text is the only >200 luma on these blocks.
  // Remapped anchors: SECOND on [3.0,5.0], THIRD on [6.0,8.0]; the drifting
  // plain anchors would be [3.5,5.5]/[7.0,9.0] — the discriminating probes
  // land in the windows where remapped and plain DISAGREE (≥ 0.4 s apart)
  assert.ok(await maxLuma(r.output, 4.0) > 200, "SECOND visible at 4.0 (both agree)");
  assert.ok(await maxLuma(r.output, 3.2) > 200, "SECOND visible at 3.2 (plain onset 3.5 — drift caught)");
  assert.ok(await maxLuma(r.output, 5.2) < 160, "SECOND gone at 5.2 (plain end 5.5 — drift caught)");
  assert.ok(await maxLuma(r.output, 6.4) > 200, "THIRD visible at 6.4 (plain onset 7.0 — drift caught)");
  assert.ok(await maxLuma(r.output, 8.2) < 160, "THIRD gone at 8.2 (plain end 9.0 — drift caught)");
  assert.ok(await maxLuma(r.output, 5.6) < 160, "nothing at 5.6 (gap between the two cues)");
  // duration law unchanged by the burn
  assert.ok(Math.abs(r.outputDuration - 9.0) < 0.04, `duration ${r.outputDuration}`);
});

test("crossfade: preview parity (same chain, preview scale, isolated path)", async () => {
  const p = await writePlan("xf4.json", xfPlan([
    ...XF_TRIMS,
    { type: "crossfade", duration: 0.5, kind: "wipeleft" },
  ], "xf4.mp4"));
  const r = await renderPlan(p, { mode: "preview" });
  assert.ok(r.output.endsWith("xf4.preview.mp4"), r.output);
  const graph = r.command[r.command.indexOf("-filter_complex") + 1]!;
  assert.ok(graph.includes("transition=wipeleft"), graph);
  assert.ok(graph.includes("scale=640:-2"), graph);
  assert.ok(graph.indexOf("scale=640:-2") < graph.indexOf("format=yuv420p"), graph);
  assert.equal(r.command.filter((a) => a === "-i").length, 3);
  assert.ok(Math.abs(r.outputDuration - 9.0) < 0.05, `duration ${r.outputDuration}`);
});

test("crossfade validation: floor, fade<every-segment (offender named), single segment, duplicates, audio-mix combo", async () => {
  // fade reaching the shortest segment (3.0s) — ffmpeg would exit 0 with
  // corrupted output; client-side validation is load-bearing
  const e1 = await validatePlan(await writePlan("xfe1.json", xfPlan([
    ...XF_TRIMS,
    { type: "crossfade", duration: 3.0 },
  ])));
  assert.equal(e1.valid, false);
  assert.equal(e1.errors[0]?.code, "OPERATION_INVALID");
  assert.ok(e1.errors[0]?.message.includes("segment 1"), e1.errors[0]?.message);
  assert.ok(e1.errors[0]?.message.includes("3.000s"), e1.errors[0]?.message);

  // sub-floor fade (0.02 < 0.05; also < one 30 fps frame)
  const e2 = await validatePlan(await writePlan("xfe2.json", xfPlan([
    ...XF_TRIMS,
    { type: "crossfade", duration: 0.02 },
  ])));
  assert.equal(e2.valid, false);
  assert.equal(e2.errors[0]?.code, "OPERATION_INVALID");
  assert.ok(e2.errors[0]?.message.includes("floor"), e2.errors[0]?.message);

  // single-segment timeline: nothing to transition (never a silent no-op)
  const e3 = await validatePlan(await writePlan("xfe3.json", xfPlan([
    { type: "trim", start: 0, end: 5 },
    { type: "crossfade", duration: 0.5 },
  ])));
  assert.equal(e3.valid, false);
  assert.equal(e3.errors[0]?.code, "OPERATION_INVALID");
  assert.ok(e3.errors[0]?.message.includes("at least 2"), e3.errors[0]?.message);
  await assert.rejects(
    () => renderPlan("xfe3.json"),
    (e: unknown) => (e as { code?: string }).code === "OPERATION_INVALID",
  );

  // duplicate crossfade
  const e4 = await validatePlan(await writePlan("xfe4.json", xfPlan([
    ...XF_TRIMS,
    { type: "crossfade", duration: 0.5 },
    { type: "crossfade", duration: 1 },
  ])));
  assert.equal(e4.valid, false);
  assert.equal(e4.errors[0]?.code, "OPERATION_INVALID");
  assert.equal(e4.errors[0]?.operation, 5);

  // crossfade + audio-mix is not a validated composition
  const e5 = await validatePlan(await writePlan("xfe5.json", xfPlan([
    ...XF_TRIMS,
    { type: "crossfade", duration: 0.5 },
    { type: "audio-mix", file: BED },
  ])));
  assert.equal(e5.valid, false);
  assert.ok(
    e5.errors.some((x) => x.code === "OPERATION_INVALID" && x.message.includes("audio-mix")),
    JSON.stringify(e5.errors),
  );

  // audio-less source is fine (video-only chain, op stays valid)
  const e6 = await validatePlan(await writePlan("xfe6.json", {
    version: 1,
    source: NOAUDIO,
    operations: [
      { type: "trim", start: 0, end: 1 },
      { type: "trim", start: 2, end: 3 },
      { type: "crossfade", duration: 0.2 },
    ],
    output: { path: "xfe6.mp4" },
  }));
  assert.equal(e6.valid, true, JSON.stringify(e6.errors));
  const r6 = await renderPlan("xfe6.json");
  assert.ok(r6.command.includes("-an"));
  assert.ok(!r6.command.join(" ").includes("acrossfade"));
  assert.ok(Math.abs(r6.outputDuration - 1.8) < 0.05, `duration ${r6.outputDuration}`);
});

test("crossfade validation: overlay-text bound consumes the crossfade-adjusted expectation", async () => {
  // expected output 9.0 (not the raw 10.0 timeline): to=9.5 rejected, 8.9 ok
  const bad = await validatePlan(await writePlan("xfo1.json", xfPlan([
    ...XF_TRIMS,
    { type: "crossfade", duration: 0.5 },
    { type: "overlay-text", text: "x", to: 9.5 },
  ])));
  assert.equal(bad.valid, false);
  assert.ok(
    bad.errors.some((x) => x.code === "OPERATION_INVALID" && x.message.includes("9.000")),
    JSON.stringify(bad.errors),
  );
  const good = await validatePlan(await writePlan("xfo2.json", xfPlan([
    ...XF_TRIMS,
    { type: "crossfade", duration: 0.5 },
    { type: "overlay-text", text: "x", to: 8.9 },
  ])));
  assert.equal(good.valid, true, JSON.stringify(good.errors));
});

// ---- T17: full-allowlist verification sweep — EVERY catalog kind renders on
// the tiny XFK fixture (2 keep-segments, 320x180@25, D=0.12). Per kind: exit
// 0 (renderPlan throws FFMPEG_FAILED otherwise), ONE -filter_complex, the
// kind actually in the xfade graph, the duration law (timeline − (N−1)·fade
// within ONE frame at 25 fps = 0.04s), a decodable output (ffprobe). Preview
// mode rides the same single-invocation transition chain at preview settings
// (~0.4 s per render, measured). All kinds attempted even when one fails —
// failures name their kind. One serial warm render first (the metadata cache
// write is not concurrency-safe), then bounded 4-way parallelism.

test("crossfade T17 sweep: EVERY allowlisted kind renders — exit 0, one pass, duration law, decodable", async () => {
  const kinds = [...CROSSFADE_KINDS];
  assert.equal(kinds.length, 58, "the pinned build's verified allowlist");
  interface Row {
    kind: string;
    duration?: number;
    decodable?: boolean;
    kindInGraph?: boolean;
    onePass?: boolean;
    error?: string;
  }
  const rows: Row[] = [];
  const renderKind = async (kind: string): Promise<void> => {
    const planPath = await writePlan(`xfk-${kind}.json`, {
      version: 1,
      source: XFK,
      operations: [
        { type: "trim", start: 0, end: 2.6 },
        { type: "cut", start: 1.2, end: 1.4 },
        { type: "crossfade", duration: 0.12, kind },
      ],
      output: { path: `xfk-${kind}.mp4` },
    });
    try {
      const r = await renderPlan(planPath, { mode: "preview" });
      const info = await inspectFile(r.output);
      const cmd = r.command.join(" ");
      rows.push({
        kind,
        duration: r.outputDuration,
        decodable: info.video != null,
        kindInGraph: cmd.includes(`xfade=transition=${kind}:duration=0.120:offset=1.080`),
        onePass: r.command.filter((a) => a === "-filter_complex").length === 1,
      });
    } catch (e) {
      const err = e as { code?: string; message?: string };
      rows.push({ kind, error: `${err.code ?? "ERROR"}: ${String(err.message).slice(0, 120)}` });
    }
  };

  await renderKind(kinds[0]!); // warm the source metadata cache serially
  const queue = kinds.slice(1);
  let cursor = 0;
  const lane = async (): Promise<void> => {
    while (cursor < queue.length) await renderKind(queue[cursor++]!);
  };
  await Promise.all([lane(), lane(), lane(), lane()]);

  assert.equal(rows.length, kinds.length, "every kind attempted exactly once");
  const failures: string[] = [];
  for (const row of rows) {
    const problems: string[] = [];
    if (row.error) problems.push(`render failed: ${row.error}`);
    if (!row.kindInGraph) problems.push("kind missing from the xfade graph");
    if (!row.onePass) problems.push("not one -filter_complex invocation (INVARIANT 1)");
    if (row.duration === undefined || Math.abs(row.duration - 2.28) > 1 / 25) {
      problems.push(`duration ${row.duration} violates the law (2.28 ± one frame)`);
    }
    if (!row.decodable) problems.push("no decodable video stream (ffprobe)");
    if (problems.length > 0) failures.push(`${row.kind}: ${problems.join("; ")}`);
  }
  assert.deepEqual(failures, [], `T17 sweep — all ${kinds.length} kinds must verify`);
});

test("crossfade: kind 'custom' parses at schema level but is fenced — OPERATION_INVALID naming expr=", async () => {
  const p = await writePlan("xfc.json", xfPlan([
    ...XF_TRIMS,
    { type: "crossfade", duration: 0.5, kind: "custom" },
  ]));
  const r = await validatePlan(p);
  assert.equal(r.valid, false);
  assert.equal(r.errors[0]?.code, "OPERATION_INVALID");
  assert.ok(r.errors[0]?.message.includes("expr="), r.errors[0]?.message);
  // the fence holds on the render path too (render re-validates)
  await assert.rejects(
    () => renderPlan(p),
    (e: unknown) => (e as { code?: string }).code === "OPERATION_INVALID",
  );
});
