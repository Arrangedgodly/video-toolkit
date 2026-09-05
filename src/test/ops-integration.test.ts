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
import { OVERLAY_FONT_FILE } from "../media/ffmpeg.js";
import { overlayFontAvailable } from "./font-availability.js";

// T25 font skip-guard — the transcribe-integration engine-guard precedent
// applied to overlay-text's FIXED font (a macOS system path; validate stats
// it and answers OPERATION_INVALID — correct-by-error — where it is absent).
// The four tests below validate/render overlay-text plans and would FAIL
// (not skip) on font-less machines (linux CI): they skip here instead; every
// other test in this file is font-independent and runs everywhere.
const fontAvailable = await overlayFontAvailable();
const fontSkip = !fontAvailable && `${OVERLAY_FONT_FILE} not present on this machine`;

const FIXTURE = "fixture.mp4"; // 12s, 1280x720, 440Hz tone
const SPEECH = "speech-gated.mp4"; // 12s, 3kHz bursts: 2.5s on / 1.5s off
const BED = "bed.mp3"; // 5s, 200Hz stereo 48kHz mp3 (shorter + rate/layout-mismatched)
const NOAUDIO = "noaudio.mp4"; // 3s video-only
const BLACK = "black.mp4"; // 2s solid black, video-only — overlay visibility probe
const BLOCKS = "blocks.mp4"; // 15s, 640x360@30: red[0,5)+440Hz, green[5,10)+880Hz,
//                            blue[10,15)+1320Hz — R3's transition fixture shape
const XFK = "xfk.mp4"; // 2.6s, 320x180@25: red[0,1.3)+440Hz, green[1.3,2.6)+880Hz
//                      — T17's tiny kind-sweep fixture (2 keep-segments via a cut)
const BARX = "barx.mp4"; // 10s, 640x360@30: black + full-height WHITE 24px bar at
//                        x=308..331 (center 320) + 440Hz tone — R5's bar-marker
//                        fixture shape (the zoom/pan visual-evidence probe)
const WM = "wm.png"; // 120x80 solid-RED rgba png — T21's watermark marker (a
//                     red rectangle on transparent; the region probe below
//                     detects it as pure red over the solid-black fixture)
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

  // R5's bar fixture (docs/ultron/research/r5-zoom-motion.md): a full-height
  // white bar on black is the marker cropdetect-style measurement needs (a
  // small marker is invisible to average-based probes; the bar's column
  // profile gives center + width per frame)
  const r8 = await runCapture("ffmpeg", [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=black:s=640x360:r=30:d=10",
    "-f", "lavfi", "-i", "sine=f=440:r=44100:d=10",
    "-vf", "drawbox=x=308:y=0:w=24:h=360:color=white:t=fill",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k", BARX,
  ]);
  assert.equal(r8.code, 0, r8.stderr);

  // T21's watermark: solid red on transparent, 120x80 — the region-probe
  // marker (pixel evidence below: exact placement at all five positions)
  const r9 = await runCapture("ffmpeg", [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=c=red:s=120x80,format=rgba",
    "-frames:v", "1", WM,
  ]);
  assert.equal(r9.code, 0, r9.stderr);
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

test("overlay-text burns in the same pass; visible only in its window; duration unchanged", { skip: fontSkip }, async () => {
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

test("overlay-text validation: from<to, output-duration bounds (speed-aware), duplicates", { skip: fontSkip }, async () => {
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

test("crossfade validation: overlay-text bound consumes the crossfade-adjusted expectation", { skip: fontSkip }, async () => {
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

// ---- export-gif (terminal op; single-pass palette graph — the recipe proven
// in vedit build_gif, vedit.py:363-375, palettegen+paletteuse INSIDE the one
// -filter_complex; the classic two-pass palette workflow would break
// INVARIANT 1 and is never used)

/** raw ffprobe stream field (fields inspectFile does not surface). */
async function probeStreamField(file: string, field: string): Promise<string> {
  const r = await runCapture("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", `stream=${field}`, "-of", "default=nw=1:nk=1", file,
  ]);
  assert.equal(r.code, 0, r.stderr);
  return r.stdout.trim();
}

test("export-gif: real gif in ONE invocation — codec/dims/frame law/window duration (speed-aware)", async () => {
  // trim[0,6] at 2x -> expected output 3s; window [0.5, 2] -> 1.5s at 12 fps = 18 frames
  const p = await writePlan("g1.json", plan([
    { type: "trim", start: 0, end: 6 },
    { type: "speed", factor: 2 },
    { type: "export-gif", width: 480, fps: 12, from: 0.5, to: 2 },
  ], "g1.gif"));
  const v = await validatePlan(p);
  assert.equal(v.valid, true, JSON.stringify(v.errors));
  // audio-bearing source -> the documented drop warning (not an error)
  assert.ok(
    v.warnings.some((w) => w.code === "GIF_AUDIO_DROPPED"),
    JSON.stringify(v.warnings),
  );

  const debugLines: string[] = [];
  const r = await renderPlan(p, { debug: (line) => debugLines.push(line) });
  // INVARIANT 1: exactly ONE ffmpeg invocation; palettegen AND paletteuse
  // inside the SAME -filter_complex (the two-pass palette workflow is NOT used)
  assert.equal(r.command[0], "ffmpeg");
  assert.equal(r.command.filter((a) => a === "-filter_complex").length, 1);
  const graph = r.command[r.command.indexOf("-filter_complex") + 1]!;
  assert.ok(graph.includes("palettegen=stats_mode=diff"), graph);
  assert.ok(graph.includes("paletteuse=dither=bayer:bayer_scale=5"), graph);
  assert.ok(graph.includes("trim=start=0.500:end=2.000,setpts=PTS-STARTPTS,fps=12"), graph);
  assert.ok(graph.includes("scale=480:-2:flags=lanczos"), graph);
  assert.equal(r.command.includes("-c:v"), false); // gif muxer, no h264 path
  assert.equal(r.command.includes("-movflags"), false);
  assert.ok(r.command.includes("-an")); // GIF carries no audio
  assert.equal(r.encoder, "gif");

  // ffprobe: it IS a gif, at the op's width with aspect preserved, no audio
  const info = await inspectFile(r.output);
  assert.equal(info.video?.codec, "gif");
  assert.equal(info.video?.width, 480);
  assert.ok(Math.abs((info.video?.height ?? 0) - 270) <= 2, `height ${info.video?.height} (720/1280·480 = 270, -2 keeps even)`);
  assert.equal(info.audio, undefined);
  // duration = the window (2 − 0.5 = 1.5s of the 3s sped-up output), within one frame at 12 fps
  assert.ok(Math.abs(r.outputDuration - 1.5) < 0.1, `duration ${r.outputDuration}`);
  assert.equal(await probeStreamField(r.output, "nb_frames"), "18"); // 1.5 s × 12 fps exactly
  // the window feeds progress/verify — a correct windowed gif must not warn
  assert.ok(
    debugLines.every((l) => !l.includes("warning: output duration")),
    `unexpected verify warning: ${debugLines.join(" | ")}`,
  );
});

test("export-gif: sub-range on the crossfade-adjusted OUTPUT timeline (composition)", async () => {
  // XF_TRIMS = 10.0s timeline, crossfade 0.5 -> expected 9.0s; window [2, 5] -> 3.0s
  const p = await writePlan("g2.json", xfPlan([
    ...XF_TRIMS,
    { type: "crossfade", duration: 0.5 },
    { type: "export-gif", from: 2, to: 5 },
  ], "g2.gif"));
  const v = await validatePlan(p);
  assert.equal(v.valid, true, JSON.stringify(v.errors));
  const r = await renderPlan(p);
  assert.equal(r.command.filter((a) => a === "-i").length, 3, "transition chain: 3 inputs, one invocation");
  assert.equal(r.command.filter((a) => a === "-filter_complex").length, 1);
  const graph = r.command[r.command.indexOf("-filter_complex") + 1]!;
  // the LAST xfade link (N=3 -> offset 5.500) hands off to [vx], which feeds
  // the window + palette suffix
  assert.ok(graph.includes("offset=5.500[vx];[vx]trim=start=2.000:end=5.000"), graph);
  assert.ok(graph.includes("paletteuse=dither=bayer:bayer_scale=5[v]"), graph);
  assert.equal(r.command.join(" ").includes("acrossfade"), false); // audio chain never built
  assert.ok(Math.abs(r.outputDuration - 3.0) < 0.1, `duration ${r.outputDuration}`);
  assert.equal(await probeStreamField(r.output, "nb_frames"), "36"); // 3.0 s × 12 fps
  const info = await inspectFile(r.output);
  assert.equal(info.video?.codec, "gif");
  assert.equal(info.video?.width, 480); // default width
});

test("export-gif: preview parity — a real .preview.gif, op width governs, full omitted window", async () => {
  // no from/to -> the whole output (6s of FIXTURE); preview must stay off the
  // final path (INVARIANT 2) and skip the mp4 preview's 640w double-scale
  const p = await writePlan("g3.json", plan([
    { type: "trim", start: 0, end: 6 },
    { type: "export-gif" },
  ], "g3.gif"));
  const r = await renderPlan(p, { mode: "preview" });
  assert.ok(r.output.endsWith("g3.preview.gif"), r.output);
  assert.equal(r.encoder, "gif");
  const graph = r.command[r.command.indexOf("-filter_complex") + 1]!;
  assert.ok(graph.includes("fps=12,scale=480:-2:flags=lanczos"), graph);
  assert.equal(graph.includes("scale=640"), false, "preview 640w not applied — the op width bounds the cost");
  assert.equal(graph.includes("trim="), false, "no window -> no trim");
  assert.ok(Math.abs(r.outputDuration - 6) < 0.1, `duration ${r.outputDuration}`);
  const info = await inspectFile(r.output);
  assert.equal(info.video?.codec, "gif");
});

test("export-gif validation: terminal position, window bounds (speed-aware), duplicates, extension, audio-mix combo", async () => {
  // terminal position: nothing may follow the export op
  const e0 = await validatePlan(await writePlan("ge0.json", plan([
    { type: "export-gif" },
    { type: "trim", start: 0, end: 2 },
  ], "ge0.gif")));
  assert.equal(e0.valid, false);
  assert.equal(e0.errors[0]?.code, "OPERATION_INVALID");
  assert.ok(e0.errors[0]?.message.includes("terminal"), e0.errors[0]?.message);

  // from >= to
  const e1 = await validatePlan(await writePlan("ge1.json", plan([
    { type: "trim", start: 0, end: 12 },
    { type: "export-gif", from: 3, to: 3 },
  ], "ge1.gif")));
  assert.equal(e1.valid, false);
  assert.equal(e1.errors[0]?.code, "RANGE_NEGATIVE");
  assert.equal(e1.errors[0]?.operation, 2);

  // to beyond the timeline (fixture is 12s)
  const e2 = await validatePlan(await writePlan("ge2.json", plan([
    { type: "trim", start: 0, end: 12 },
    { type: "export-gif", to: 13 },
  ], "ge2.gif")));
  assert.equal(e2.valid, false);
  assert.equal(e2.errors[0]?.code, "OPERATION_INVALID");
  assert.ok(e2.errors[0]?.message.includes("exceeds expected output duration"), e2.errors[0]?.message);

  // speed-aware bound: timeline 12 at 2x -> expected 6s (both edges checked)
  const e3 = await validatePlan(await writePlan("ge3.json", plan([
    { type: "trim", start: 0, end: 12 },
    { type: "speed", factor: 2 },
    { type: "export-gif", to: 6.5 },
  ], "ge3.gif")));
  assert.equal(e3.valid, false);
  assert.equal(e3.errors[0]?.code, "OPERATION_INVALID");
  const e4 = await validatePlan(await writePlan("ge4.json", plan([
    { type: "trim", start: 0, end: 12 },
    { type: "speed", factor: 2 },
    { type: "export-gif", from: 5.9, to: 6 },
  ], "ge4.gif")));
  assert.equal(e4.valid, true, JSON.stringify(e4.errors));

  // duplicate export-gif (a duplicate ALSO trips the terminal fence on the
  // first copy — something follows it — so match the duplicate error itself)
  const e5 = await validatePlan(await writePlan("ge5.json", plan([
    { type: "trim", start: 0, end: 2 },
    { type: "export-gif" },
    { type: "export-gif", width: 320 },
  ], "ge5.gif")));
  assert.equal(e5.valid, false);
  assert.ok(
    e5.errors.some((x) => x.code === "OPERATION_INVALID" && x.operation === 3 && /duplicate export-gif/.test(x.message)),
    JSON.stringify(e5.errors),
  );

  // .gif extension rule on BOTH paths (validate AND render re-validation)
  const e6 = await validatePlan(await writePlan("ge6.json", plan([
    { type: "trim", start: 0, end: 2 },
    { type: "export-gif" },
  ], "ge6.mp4")));
  assert.equal(e6.valid, false);
  assert.equal(e6.errors[0]?.code, "OUTPUT_PATH_INVALID");
  assert.ok(e6.errors[0]?.message.includes(".gif"), e6.errors[0]?.message);
  await assert.rejects(
    () => renderPlan("ge6.json"),
    (e: unknown) => (e as { code?: string }).code === "OUTPUT_PATH_INVALID",
  );

  // export-gif + audio-mix: the bed would be a silently dropped no-op
  const e7 = await validatePlan(await writePlan("ge7.json", plan([
    { type: "trim", start: 0, end: 4 },
    { type: "audio-mix", file: BED },
    { type: "export-gif" },
  ], "ge7.gif")));
  assert.equal(e7.valid, false);
  assert.ok(
    e7.errors.some((x) => x.code === "OPERATION_INVALID" && x.message.includes("audio-mix")),
    JSON.stringify(e7.errors),
  );

  // audio-less source: valid, and NO drop warning (nothing to drop)
  const e8 = await validatePlan(await writePlan("ge8.json", {
    version: 1,
    source: NOAUDIO,
    operations: [{ type: "trim", start: 0, end: 2 }, { type: "export-gif" }],
    output: { path: "ge8.gif" },
  }));
  assert.equal(e8.valid, true, JSON.stringify(e8.errors));
  assert.equal(
    e8.warnings.some((w) => w.code === "GIF_AUDIO_DROPPED"),
    false,
    JSON.stringify(e8.warnings),
  );
});

// ---- zoom (T18; single-pass Ken Burns motion on BOTH render paths per R5's
// committed contract, docs/ultron/research/r5-zoom-motion.md — every duration
// claim below is measured against a SAME-PLAN-WITHOUT-ZOOM control, never
// the nominal timeline: the select path's inclusive `between` emits +1 frame
// per segment (keep [1,4]+[5.5,9.5] = 212 frames / 7.0667 s, the record's C0)

function barPlan(operations: unknown[], output = "z.mp4"): unknown {
  return { version: 1, source: BARX, operations, output: { path: output } };
}

const ZOOM_TRIMS = [
  { type: "trim", start: 1, end: 4 },
  { type: "trim", start: 5.5, end: 9.5 },
];

/** column profile of the full-height bar marker in one decoded frame — the
 * visual-evidence probe (center + width; detector slop ±1-2 px on the edges,
 * far below every asserted delta). */
async function barProfile(file: string, t: number): Promise<{ center: number; width: number }> {
  const r = await runCapture("ffmpeg", [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    "-ss", String(t), "-i", file,
    "-frames:v", "1", "-pix_fmt", "gray", "-f", "rawvideo", "bar-t18.raw",
  ]);
  assert.equal(r.code, 0, r.stderr);
  const buf = await readFile("bar-t18.raw");
  const W = 640;
  const H = 360;
  let xMin = -1;
  let xMax = -1;
  for (let x = 0; x < W; x++) {
    let bright = 0;
    for (let y = 0; y < H; y++) if (buf[y * W + x]! > 128) bright++;
    if (bright > H / 2) {
      if (xMin === -1) xMin = x;
      xMax = x;
    }
  }
  assert.ok(xMin !== -1, `bar marker not found at t=${t}`);
  return { center: (xMin + xMax) / 2, width: xMax - xMin + 1 };
}

test("zoom: select-path render is ONE invocation, duration FRAME-EXACT vs the no-zoom control, visible zoom-in", async () => {
  const p = await writePlan("z1.json", barPlan([
    ...ZOOM_TRIMS,
    { type: "zoom", mode: "in", factor: 1.5, easing: "linear" },
  ], "z1.mp4"));
  const control = await writePlan("z1c.json", barPlan([...ZOOM_TRIMS], "z1c.mp4"));
  const v = await validatePlan(p);
  assert.equal(v.valid, true, JSON.stringify(v.errors));
  // visual-only op: zoom never enters a duration law (no new report fields)
  assert.equal(v.expectedDuration, undefined);
  assert.ok(Math.abs((v.timelineDuration ?? 0) - 7) < 0.01);

  const r = await renderPlan(p);
  // INVARIANT 1: exactly ONE ffmpeg invocation, plain -vf path
  assert.equal(r.command[0], "ffmpeg");
  assert.equal(r.command.filter((a) => a === "-i").length, 1);
  assert.equal(r.command.includes("-filter_complex"), false);
  const vf = r.command[r.command.indexOf("-vf") + 1]!;
  // one continuous ramp over the WHOLE timeline (N = round(7.0×30) = 210),
  // the R5 discipline string verbatim, between select and the retime setpts
  assert.ok(
    vf.includes("zoompan=z='1+0.5*min(on/209,1)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:fps=30:s=640x360"),
    vf,
  );
  assert.ok(
    vf.indexOf("select=") < vf.indexOf("zoompan=") && vf.indexOf("zoompan=") < vf.indexOf("setpts="),
    `zoompan must sit between select and setpts: ${vf}`,
  );

  // DURATION INVARIANCE, frame-exact (the record's C0/C3 pair: 212/212):
  // the no-op default d=90 would blow this to 19,080 frames
  const rc = await renderPlan(control);
  assert.equal(await probeStreamField(r.output, "nb_frames"), "212");
  assert.equal(await probeStreamField(rc.output, "nb_frames"), "212");
  assert.ok(
    Math.abs(r.outputDuration - rc.outputDuration) < 0.02,
    `duration must equal the no-zoom control: ${r.outputDuration} vs ${rc.outputDuration}`,
  );

  // VISUAL EVIDENCE: the marker grows 24 px -> 36 px (F=1.5) while its
  // CENTER stays anchored — an incremental-expression regression (the
  // classic no-op) would leave the width at ~24 and fail this
  const early = await barProfile(r.output, 0.2);
  const mid = await barProfile(r.output, 3.5);
  const late = await barProfile(r.output, 6.8);
  assert.ok(early.width < mid.width + 2 && mid.width < late.width + 2, `monotonic growth: ${early.width} ${mid.width} ${late.width}`);
  assert.ok(late.width - early.width > 8, `zoom-in must grow the marker: ${early.width} -> ${late.width}`);
  for (const probe of [early, mid, late]) {
    assert.ok(Math.abs(probe.center - 320) <= 3, `center-anchored zoom wobble ≤ ±3 px: ${probe.center}`);
  }
});

test("zoom: pan right drifts the content LEFT (camera convention), prescaled; frame-exact invariance + preview parity", async () => {
  const p = await writePlan("z2.json", barPlan([
    ...ZOOM_TRIMS,
    { type: "zoom", mode: "right", factor: 1.2, easing: "linear" },
  ], "z2.mp4"));
  const control = await writePlan("z2c.json", barPlan([...ZOOM_TRIMS], "z2c.mp4"));
  const r = await renderPlan(p);
  const vf = r.command[r.command.indexOf("-vf") + 1]!;
  // PAN modes carry the ×2 prescale before zoompan; z is the CONSTANT F
  assert.ok(
    vf.includes("scale=1280:720,zoompan=z='1.2':x='(iw-iw/zoom)*min(on/209,1)':y='ih/2-(ih/zoom/2)':d=1:fps=30:s=640x360"),
    vf,
  );
  // duration invariance, frame-exact
  const rc = await renderPlan(control);
  assert.equal(await probeStreamField(r.output, "nb_frames"), "212");
  assert.equal(await probeStreamField(rc.output, "nb_frames"), "212");

  // VISUAL EVIDENCE: camera pans right => content drifts LEFT, monotonic,
  // full traverse (1−1/1.2)·640 ≈ 107 px (samples span the ramp)
  const a = await barProfile(r.output, 0.3);
  const b = await barProfile(r.output, 3.5);
  const c = await barProfile(r.output, 6.7);
  assert.ok(a.center > b.center + 20, `drift left: ${a.center} -> ${b.center}`);
  assert.ok(b.center > c.center + 20, `drift continues: ${b.center} -> ${c.center}`);
  assert.ok(a.center - c.center > 60, `full-range pan: net drift ${a.center - c.center} px (ideal ~107)`);

  // preview parity: same motion at preview settings, isolated path
  const pv = await renderPlan(p, { mode: "preview" });
  assert.ok(pv.output.endsWith("z2.preview.mp4"), pv.output);
  const pvf = pv.command[pv.command.indexOf("-vf") + 1]!;
  assert.ok(pvf.includes("zoompan=z='1.2'"), pvf);
  assert.ok(pvf.indexOf("zoompan=") < pvf.indexOf("scale=640:-2"), `preview scale comes after the motion: ${pvf}`);
  assert.ok(Math.abs(pv.outputDuration - r.outputDuration) < 0.05);
});

test("zoom: crossfade chain zoompans EVERY input with its own ramp; R3's duration law frame-exact", async () => {
  // R5's exact F2 composition: N=2, F=1.3 per segment, D=0.5 — per-input
  // ramps N_1=90 (L=3.0) and N_2=120 (L=4.0), xfade over the [z0][z1] outputs
  const p = await writePlan("z3.json", barPlan([
    ...ZOOM_TRIMS,
    { type: "crossfade", duration: 0.5 },
    { type: "zoom", mode: "in", factor: 1.3, easing: "linear" },
  ], "z3.mp4"));
  const control = await writePlan("z3c.json", barPlan([
    ...ZOOM_TRIMS,
    { type: "crossfade", duration: 0.5 },
  ], "z3c.mp4"));
  const v = await validatePlan(p);
  assert.equal(v.valid, true, JSON.stringify(v.errors));

  const r = await renderPlan(p);
  // ONE invocation, 2 inputs of the SAME source, zoompan on BOTH inputs
  assert.equal(r.command.filter((a) => a === "-i").length, 2);
  assert.equal(r.command.filter((a) => a === "-filter_complex").length, 1);
  const graph = r.command[r.command.indexOf("-filter_complex") + 1]!;
  assert.ok(graph.startsWith("[0:v]zoompan=z='1+0.3*min(on/89,1)'"), graph);
  assert.ok(graph.includes("zoompan=z='1+0.3*min(on/119,1)'"), graph);
  assert.ok(graph.includes("[z0][z1]xfade=transition=fade:duration=0.500:offset=2.500"), graph);

  // DURATION LAW frame-exact: timeline 7.0 − 0.5 = 6.5 s = 195 frames,
  // identical to the no-zoom crossfade control (the record's F1/F2 pair)
  const rc = await renderPlan(control);
  assert.equal(await probeStreamField(r.output, "nb_frames"), "195");
  assert.equal(await probeStreamField(rc.output, "nb_frames"), "195");
  assert.ok(Math.abs(r.outputDuration - 6.5) < 0.04, `duration ${r.outputDuration}`);
  assert.ok(Math.abs(r.outputDuration - rc.outputDuration) < 0.02);

  // VISUAL EVIDENCE: motion re-runs per segment (the reset at the join is
  // the documented chain-path semantic) — the bar grows within segment 2
  const early = await barProfile(r.output, 0.2);
  const late = await barProfile(r.output, 6.2);
  assert.ok(late.width > early.width + 4, `per-segment zoom-in: ${early.width} -> ${late.width}`);
});

test("zoom composes with speed + captions + overlay-text in the SAME single pass (R5's G1 matrix)", { skip: fontSkip }, async () => {
  await writeFile("z4.srt", "1\n00:00:00,000 --> 00:00:02,000\nHELLO ZOOM\n");
  const p = await writePlan("z4.json", barPlan([
    ...ZOOM_TRIMS,
    { type: "zoom", mode: "in", factor: 1.3 }, // defaults exercised: easing smooth
    { type: "speed", factor: 1.25 },
    { type: "captions", file: "z4.srt" },
    { type: "overlay-text", text: "Title", from: 0.5, to: 3 },
  ], "z4.mp4"));
  const control = await writePlan("z4c.json", barPlan([
    ...ZOOM_TRIMS,
    { type: "speed", factor: 1.25 },
    { type: "captions", file: "z4.srt" },
    { type: "overlay-text", text: "Title", from: 0.5, to: 3 },
  ], "z4c.mp4"));
  const v = await validatePlan(p);
  assert.equal(v.valid, true, JSON.stringify(v.errors));

  const r = await renderPlan(p);
  assert.equal(r.command[0], "ffmpeg");
  assert.equal(r.command.filter((a) => a === "-i").length, 1);
  assert.equal(r.command.includes("-filter_complex"), false);
  // composition order (R5): motion EARLY, text LATE — zoompan < setpts/speed
  // < subtitles < drawtext < format, all inside the one -vf
  const vf = r.command[r.command.indexOf("-vf") + 1]!;
  const order = ["select=", "zoompan=", "setpts=N/FRAME_RATE/TB/1.25", "subtitles=", "drawtext=", "format=yuv420p"];
  let prev = -1;
  for (const part of order) {
    const at = vf.indexOf(part);
    assert.ok(at !== -1, `${part} missing: ${vf}`);
    assert.ok(at > prev, `${part} must come after the previous stage: ${vf}`);
    prev = at;
  }
  // smooth easing rides the graph (the default)
  assert.ok(vf.includes("zoompan=z='1+0.3*min(on/209,1)*min(on/209,1)*(3-2*min(on/209,1))'"), vf);

  // duration law through the full stack (the record's C7: zoom+speed =
  // 170 f / 5.666667 s — the speed law alone governs). At FRACTIONAL speeds
  // the trailing frame is path-sensitive within ONE frame (zoompan
  // regenerates PTS at exact 1/fps steps; the plain select path carries
  // container rounding — measured plain 171/5.700 vs zoom 170/5.6667): the
  // record's own tolerance ("frame-exact or ≤1 frame") governs here, while
  // the exact-count invariance lives in the no-speed tests above
  const rc = await renderPlan(control);
  assert.ok(
    Math.abs(Number(await probeStreamField(r.output, "nb_frames")) - 212 / 1.25) <= 1,
    `zoom frame count vs 212/1.25`,
  );
  assert.ok(
    Math.abs(r.outputDuration - rc.outputDuration) <= 1 / 30 + 0.01,
    `zoom must not re-time the composition: ${r.outputDuration} vs control ${rc.outputDuration}`,
  );
  assert.ok(Math.abs(r.outputDuration - 7.0667 / 1.25) < 0.05, `duration ${r.outputDuration}`);
});

test("zoom validation: factor range, duplicates, sub-2-frame ramp units; render throws the code", async () => {
  // factor fences (R5's constraints table — strict 1.0 < f ≤ 2.0)
  for (const factor of [1, 0.5, 2.5]) {
    const r = await validatePlan(await writePlan(`ze-f${factor}.json`, barPlan([
      { type: "trim", start: 0, end: 4 },
      { type: "zoom", factor },
    ])));
    assert.equal(r.valid, false, `factor ${factor} must be fenced`);
    assert.equal(r.errors[0]?.code, "OPERATION_INVALID");
    assert.ok(r.errors[0]?.message.includes("1.0 < f ≤ 2.0"), r.errors[0]?.message);
  }
  // boundaries are legal: exactly 2.0, just above 1.0
  for (const factor of [2, 1.001]) {
    const r = await validatePlan(await writePlan(`ze-ok${factor}.json`, barPlan([
      { type: "trim", start: 0, end: 4 },
      { type: "zoom", factor },
    ])));
    assert.equal(r.valid, true, JSON.stringify(r.errors));
  }

  // duplicate zoom joins the seenTransforms rule
  const dup = await validatePlan(await writePlan("ze-dup.json", barPlan([
    { type: "trim", start: 0, end: 4 },
    { type: "zoom" },
    { type: "zoom", mode: "left" },
  ])));
  assert.equal(dup.valid, false);
  assert.equal(dup.errors[0]?.code, "OPERATION_INVALID");
  assert.equal(dup.errors[0]?.operation, 3);

  // ramp-unit fence: a 0.02 s timeline at 30 fps = 1 frame (exit-0
  // degenerate render upstream — fenced client-side instead)
  const tiny = await validatePlan(await writePlan("ze-tiny.json", barPlan([
    { type: "trim", start: 0, end: 0.02 },
    { type: "zoom" },
  ])));
  assert.equal(tiny.valid, false);
  assert.equal(tiny.errors[0]?.code, "OPERATION_INVALID");
  assert.ok(tiny.errors[0]?.message.includes("2 source frames"), tiny.errors[0]?.message);

  // the fences hold on the render path too (render re-validates)
  await assert.rejects(
    () => renderPlan("ze-f2.5.json"),
    (e: unknown) => (e as { code?: string }).code === "OPERATION_INVALID",
  );
  await assert.rejects(
    () => renderPlan("ze-tiny.json"),
    (e: unknown) => (e as { code?: string }).code === "OPERATION_INVALID",
  );
});

// ---- image-overlay (T21; ONE image burned over the composed output via an
// ADDITIONAL input — pixel-verified placement on solid-black fixtures: the
// 120x80 red marker must appear at exactly one of the five spots (640x360,
// margin 16) and NOWHERE else, on the select path, the crossfade chain, and
// the gif path — each a SINGLE invocation)

/** mean RGB of a rectangular region in one decoded frame — the placement
 * probe (red marker ≈ {252,0,0} over solid black {0,0,0}; inner insets dodge
 * the encoder's 4:2:0 edge blur). */
async function regionMean(
  file: string,
  t: number,
  x: number,
  y: number,
  w: number,
  h: number,
): Promise<{ r: number; g: number; b: number }> {
  const r = await runCapture("ffmpeg", [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    "-ss", String(t), "-i", file,
    "-frames:v", "1", "-vf", `crop=${w}:${h}:${x}:${y}`, "-pix_fmt", "rgb24",
    "-f", "rawvideo", "t21-region.raw",
  ]);
  assert.equal(r.code, 0, r.stderr);
  const buf = await readFile("t21-region.raw");
  assert.equal(buf.length, w * h * 3, `region ${w}x${h} decode`);
  let rr = 0, gg = 0, bb = 0;
  for (let i = 0; i < buf.length; i += 3) {
    rr += buf[i]!;
    gg += buf[i + 1]!;
    bb += buf[i + 2]!;
  }
  const n = w * h;
  return { r: rr / n, g: gg / n, b: bb / n };
}

/** the five placement spots for a 120x80 marker on 640x360 at margin 16. */
const OVERLAY_SPOTS = {
  "top-left": { x: 16, y: 16 },
  "top-right": { x: 504, y: 16 },
  "bottom-left": { x: 16, y: 264 },
  "bottom-right": { x: 504, y: 264 },
  center: { x: 260, y: 140 },
} as const;
type OverlaySpot = keyof typeof OVERLAY_SPOTS;

function wmPlan(ops: unknown[], output: string): unknown {
  return { version: 1, source: BLACK, operations: ops, output: { path: output } };
}

test("image-overlay: all five positions pixel-verified on the select path; ONE invocation each", async () => {
  for (const position of Object.keys(OVERLAY_SPOTS) as OverlaySpot[]) {
    const p = await writePlan(`io-${position}.json`, wmPlan([
      { type: "trim", start: 0, end: 2 },
      { type: "image-overlay", file: WM, position },
    ], `io-${position}.mp4`));
    const v = await validatePlan(p);
    assert.equal(v.valid, true, `${position}: ${JSON.stringify(v.errors)}`);
    const r = await renderPlan(p);
    // INVARIANT 1: exactly ONE invocation, two inputs (source + image), the
    // video graph flipped into -filter_complex (a -vf chain cannot do this)
    assert.equal(r.command[0], "ffmpeg");
    assert.equal(r.command.filter((a) => a === "-i").length, 2, position);
    assert.deepEqual(r.command.filter((_, i) => r.command[i - 1] === "-i"), [BLACK, WM]);
    assert.equal(r.command.filter((a) => a === "-filter_complex").length, 1);
    assert.equal(r.command.includes("-vf"), false);
    const graph = r.command[r.command.indexOf("-filter_complex") + 1]!;
    assert.ok(graph.includes("[vb][im]overlay=x="), `${position}: ${graph}`);

    // PIXEL EVIDENCE: exactly the target spot carries the marker at t=1.0 —
    // every other spot is untouched solid black
    for (const spot of Object.keys(OVERLAY_SPOTS) as OverlaySpot[]) {
      const s = OVERLAY_SPOTS[spot];
      const m = await regionMean(r.output, 1.0, s.x + 10, s.y + 10, 100, 60);
      if (spot === position) {
        assert.ok(
          m.r > 180 && m.g < 60 && m.b < 60,
          `${position}: marker expected at ${spot}: ${JSON.stringify(m)}`,
        );
      } else {
        assert.ok(
          m.r < 12 && m.g < 12 && m.b < 12,
          `${position}: ${spot} must stay solid black: ${JSON.stringify(m)}`,
        );
      }
    }
    // a burn, not a re-time: duration unchanged
    assert.ok(Math.abs(r.outputDuration - 2) < 0.2, `${position}: duration ${r.outputDuration}`);
  }
});

test("image-overlay: enable window — visible inside, absent on BOTH sides; preview parity", async () => {
  const p = await writePlan("io-win.json", wmPlan([
    { type: "trim", start: 0, end: 2 },
    { type: "image-overlay", file: WM, from: 0.5, to: 1.5 },
  ], "io-win.mp4"));
  const r = await renderPlan(p);
  const cmd = r.command.join(" ");
  assert.ok(cmd.includes("enable='between(t,0.500,1.500)'"), cmd);
  const inside = await regionMean(r.output, 1.0, 514, 274, 100, 60);
  const early = await regionMean(r.output, 0.2, 514, 274, 100, 60);
  const late = await regionMean(r.output, 1.9, 514, 274, 100, 60);
  assert.ok(inside.r > 180, `visible inside the window: ${JSON.stringify(inside)}`);
  assert.ok(early.r < 12, `invisible before the window: ${JSON.stringify(early)}`);
  assert.ok(late.r < 12, `invisible after the window: ${JSON.stringify(late)}`);

  const pv = await renderPlan(p, { mode: "preview", force: true });
  assert.ok(pv.output.endsWith("io-win.preview.mp4"), pv.output);
  assert.ok(pv.command.join(" ").includes("overlay=x="), "preview carries the same overlay");
});

test("image-overlay: opacity dims the marker (aa=0.5 halves the region exactly)", async () => {
  const full = await renderPlan(await writePlan("io-op1.json", wmPlan([
    { type: "trim", start: 0, end: 2 },
    { type: "image-overlay", file: WM },
  ], "io-op1.mp4")));
  const half = await renderPlan(await writePlan("io-op05.json", wmPlan([
    { type: "trim", start: 0, end: 2 },
    { type: "image-overlay", file: WM, opacity: 0.5 },
  ], "io-op05.mp4")));
  assert.ok(half.command.join(" ").includes("colorchannelmixer=aa=0.5"));
  const m1 = await regionMean(full.output, 1.0, 514, 274, 100, 60);
  const m2 = await regionMean(half.output, 1.0, 514, 274, 100, 60);
  assert.ok(m1.r > 180, `full-opacity marker: ${JSON.stringify(m1)}`);
  const ratio = m2.r / m1.r;
  assert.ok(
    ratio > 0.4 && ratio < 0.6 && m2.g < 30 && m2.b < 30,
    `aa=0.5 must halve the marker: ${m1.r} -> ${m2.r} (ratio ${ratio.toFixed(3)})`,
  );
});

test("image-overlay: width scales the marker keeping aspect (60x40), nothing beyond it", async () => {
  const r = await renderPlan(await writePlan("io-w60.json", wmPlan([
    { type: "trim", start: 0, end: 2 },
    { type: "image-overlay", file: WM, position: "top-left", width: 60 },
  ], "io-w60.mp4")));
  const cmd = r.command.join(" ");
  assert.ok(cmd.includes("scale=60:-1"), cmd); // exact aspect (-1), not -2
  const inner = await regionMean(r.output, 1.0, 22, 22, 48, 28); // inside the 60x40 marker
  const beyond = await regionMean(r.output, 1.0, 90, 22, 40, 28); // inside the NATIVE footprint, outside the scaled marker
  assert.ok(inner.r > 180, `scaled marker present: ${JSON.stringify(inner)}`);
  assert.ok(beyond.r < 12 && beyond.g < 12, `beyond the scaled width stays black: ${JSON.stringify(beyond)}`);
});

test("image-overlay: crossfade chain path — ONE invocation (2 source inputs + image), marker over the join", async () => {
  // keeps [0,0.8]+[1.2,2.0] = 1.6s, fade 0.2 -> expected 1.4s
  const p = await writePlan("io-chain.json", wmPlan([
    { type: "trim", start: 0, end: 0.8 },
    { type: "trim", start: 1.2, end: 2 },
    { type: "crossfade", duration: 0.2 },
    { type: "image-overlay", file: WM },
  ], "io-chain.mp4"));
  const v = await validatePlan(p);
  assert.equal(v.valid, true, JSON.stringify(v.errors));
  const r = await renderPlan(p);
  assert.equal(r.command.filter((a) => a === "-i").length, 3, "2 source inputs + the image");
  assert.deepEqual(r.command.filter((_, i) => r.command[i - 1] === "-i"), [BLACK, BLACK, WM]);
  assert.equal(r.command.filter((a) => a === "-filter_complex").length, 1);
  const graph = r.command[r.command.indexOf("-filter_complex") + 1]!;
  assert.ok(graph.includes("[vc][im]overlay=x=W-w-16:y=H-h-16,format=yuv420p[v]"), graph);
  assert.ok(Math.abs(r.outputDuration - 1.4) < 0.05, `duration ${r.outputDuration}`);

  // marker present in pure segment 1, ON TOP of the fade window, absent elsewhere
  const seg1 = await regionMean(r.output, 0.4, 514, 274, 100, 60);
  const fade = await regionMean(r.output, 0.75, 514, 274, 100, 60);
  const tl = await regionMean(r.output, 0.4, 26, 26, 100, 60);
  assert.ok(seg1.r > 180, `marker in pure content: ${JSON.stringify(seg1)}`);
  assert.ok(fade.r > 180, `marker over the fade join: ${JSON.stringify(fade)}`);
  assert.ok(tl.r < 12 && tl.g < 12, `top-left untouched: ${JSON.stringify(tl)}`);
});

test("image-overlay: gif path — marker rides BEFORE the palette graph, ONE invocation, real gif", async () => {
  const p = await writePlan("io-gif.json", wmPlan([
    { type: "trim", start: 0, end: 2 },
    { type: "image-overlay", file: WM, position: "top-left" },
    { type: "export-gif", width: 480 },
  ], "io-gif.gif"));
  const v = await validatePlan(p);
  assert.equal(v.valid, true, JSON.stringify(v.errors));
  const r = await renderPlan(p);
  assert.equal(r.encoder, "gif");
  assert.equal(r.command.filter((a) => a === "-i").length, 2, "source + image, one invocation");
  assert.equal(r.command.filter((a) => a === "-filter_complex").length, 1);
  const graph = r.command[r.command.indexOf("-filter_complex") + 1]!;
  assert.ok(graph.includes("[vb][im]overlay=x=16:y=16,"), graph);
  assert.ok(graph.indexOf("overlay=") < graph.indexOf("fps=12"), graph); // before the palette suffix
  assert.ok(graph.includes("palettegen=stats_mode=diff"), graph);
  const info = await inspectFile(r.output);
  assert.equal(info.video?.codec, "gif");
  assert.equal(info.video?.width, 480);

  // pixel evidence at 480x270: the marker scales to 90x60 at (12,12); the
  // bottom-right spot (378,183) stays black (palette-quantized red still red)
  const m = await regionMean(r.output, 1.0, 18, 18, 78, 48);
  const br = await regionMean(r.output, 1.0, 384, 189, 78, 48);
  assert.ok(m.r > 150 && m.g < 60, `marker in the gif: ${JSON.stringify(m)}`);
  assert.ok(br.r < 20 && br.g < 20, `opposite corner stays black: ${JSON.stringify(br)}`);
});

test("image-overlay validation: missing file, opacity fence, window, output-duration bound (speed-aware), duplicates", async () => {
  // missing image file -> OPERATION_INVALID carrying the path
  const e1 = await validatePlan(await writePlan("ie1.json", plan([
    { type: "trim", start: 0, end: 12 },
    { type: "image-overlay", file: "missing-wm.png" },
  ])));
  assert.equal(e1.valid, false);
  assert.equal(e1.errors[0]?.code, "OPERATION_INVALID");
  assert.equal(e1.errors[0]?.path, "missing-wm.png");
  assert.equal(e1.errors[0]?.operation, 2);
  await assert.rejects(
    () => renderPlan("ie1.json"),
    (e: unknown) => (e as { code?: string }).code === "OPERATION_INVALID",
  );

  // opacity fence (0 / 1.5 parse at schema level; validate rejects, boundaries pass)
  for (const opacity of [0, 1.5]) {
    const r = await validatePlan(await writePlan(`ie-o${opacity}.json`, plan([
      { type: "trim", start: 0, end: 12 },
      { type: "image-overlay", file: WM, opacity },
    ])));
    assert.equal(r.valid, false, `opacity ${opacity} must be fenced`);
    assert.equal(r.errors[0]?.code, "OPERATION_INVALID");
    assert.ok(r.errors[0]?.message.includes("0 < o ≤ 1"), r.errors[0]?.message);
  }
  for (const opacity of [1, 0.001]) {
    const r = await validatePlan(await writePlan(`ie-ok${opacity}.json`, plan([
      { type: "trim", start: 0, end: 12 },
      { type: "image-overlay", file: WM, opacity },
    ])));
    assert.equal(r.valid, true, `opacity ${opacity}: ${JSON.stringify(r.errors)}`);
  }

  // from >= to
  const e2 = await validatePlan(await writePlan("ie2.json", plan([
    { type: "trim", start: 0, end: 12 },
    { type: "image-overlay", file: WM, from: 3, to: 3 },
  ])));
  assert.equal(e2.valid, false);
  assert.equal(e2.errors[0]?.code, "RANGE_NEGATIVE");
  assert.equal(e2.errors[0]?.operation, 2);

  // to beyond the timeline (fixture is 12s)
  const e3 = await validatePlan(await writePlan("ie3.json", plan([
    { type: "trim", start: 0, end: 12 },
    { type: "image-overlay", file: WM, to: 13 },
  ])));
  assert.equal(e3.valid, false);
  assert.equal(e3.errors[0]?.code, "OPERATION_INVALID");
  assert.ok(e3.errors[0]?.message.includes("exceeds expected output duration"), e3.errors[0]?.message);

  // speed-aware bound: timeline 12 at 2x -> expected output 6s
  const e4 = await validatePlan(await writePlan("ie4.json", plan([
    { type: "trim", start: 0, end: 12 },
    { type: "speed", factor: 2 },
    { type: "image-overlay", file: WM, to: 6.5 },
  ])));
  assert.equal(e4.valid, false);
  assert.equal(e4.errors[0]?.code, "OPERATION_INVALID");
  const e5 = await validatePlan(await writePlan("ie5.json", plan([
    { type: "trim", start: 0, end: 12 },
    { type: "speed", factor: 2 },
    { type: "image-overlay", file: WM, to: 5.9 },
  ])));
  assert.equal(e5.valid, true, JSON.stringify(e5.errors));

  // duplicate op joins the seenTransforms rule; render of it throws the code
  const e6 = await validatePlan(await writePlan("ie6.json", plan([
    { type: "trim", start: 0, end: 12 },
    { type: "image-overlay", file: WM },
    { type: "image-overlay", file: WM },
  ])));
  assert.equal(e6.valid, false);
  assert.equal(e6.errors[0]?.code, "OPERATION_INVALID");
  assert.equal(e6.errors[0]?.operation, 3);
  await assert.rejects(
    () => renderPlan("ie6.json"),
    (e: unknown) => (e as { code?: string }).code === "OPERATION_INVALID",
  );
});
