import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { runCapture, inspectFile } from "../media/ffprobe.js";
import { detectSilence } from "../analysis/silence.js";
import { detectScenes } from "../analysis/scenes.js";
import { extractFrames } from "../analysis/frames.js";
import { generateProxy } from "../analysis/proxy.js";
import { validatePlan } from "../validate/validate.js";

// tone 0-3s, silence 3-5s, tone 5-8s — the ground-truth silence fixture
const SILENCE = "sil.mp4";
// hard visual cuts at 3s (black->white) and 6s (white->red)
const SCENES = "scenes.mp4";
let dir = "";

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "video-toolkit-m2-"));
  process.chdir(dir);

  const sil = await runCapture("ffmpeg", [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30",
    "-f", "lavfi", "-i",
    "aevalsrc=0.4*sin(440*2*PI*t)*between(t\\,0\\,3)+0.4*sin(440*2*PI*t)*between(t\\,5\\,8):s=44100:d=8",
    "-t", "8", "-c:v", "libx264", "-crf", "23", "-pix_fmt", "yuv420p", "-c:a", "aac", SILENCE,
  ]);
  assert.equal(sil.code, 0, sil.stderr);

  const sc = await runCapture("ffmpeg", [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=c=black:s=320x240:r=10:d=3",
    "-f", "lavfi", "-i", "color=c=white:s=320x240:r=10:d=3",
    "-f", "lavfi", "-i", "color=c=red:s=320x240:r=10:d=3",
    "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0",
    "-c:v", "libx264", "-crf", "23", "-pix_fmt", "yuv420p", SCENES,
  ]);
  assert.equal(sc.code, 0, sc.stderr);
});

after(async () => {
  process.chdir(tmpdir());
  await rm(dir, { recursive: true, force: true });
});

test("detect-silence finds the known gap at ~3-5s", async () => {
  const r = await detectSilence(SILENCE, { thresholdDb: 35, minDurationSec: 0.5 });
  assert.equal(r.segments.length, 1, JSON.stringify(r));
  const seg = r.segments[0]!;
  assert.ok(Math.abs(seg.start - 3) < 0.2, `start ${seg.start}`);
  assert.ok(Math.abs(seg.end - 5) < 0.2, `end ${seg.end}`);
  assert.ok(Math.abs(seg.duration - 2) < 0.4);
});

test("detect-silence is cached per source+params", async () => {
  const a = await detectSilence(SILENCE, { thresholdDb: 35, minDurationSec: 0.5 });
  const b = await detectSilence(SILENCE, { thresholdDb: 35, minDurationSec: 0.5 });
  assert.deepEqual(a, b);
});

test("detect-silence on a video without audio returns empty with note", async () => {
  const r = await detectSilence(SCENES, { thresholdDb: 35, minDurationSec: 0.5 });
  assert.equal(r.segments.length, 0);
  assert.equal(r.note, "no audio stream");
});

test("detect-scenes finds hard cuts at ~3s and ~6s", async () => {
  const r = await detectScenes(SCENES, { threshold: 0.3 });
  const times = r.boundaries.map((b) => b.timestamp);
  assert.equal(r.boundaries.length, 2, JSON.stringify(r));
  assert.ok(Math.abs(times[0]! - 3) < 0.3, `first ${times[0]}`);
  assert.ok(Math.abs(times[1]! - 6) < 0.3, `second ${times[1]}`);
  for (const b of r.boundaries) {
    assert.ok(b.confidence > 0.3 && b.confidence <= 1);
  }
});

test("extract-frame writes the requested stills", async () => {
  const r = await extractFrames(SILENCE, { at: [1, 4, 7], size: 320 });
  assert.equal(r.frames.length, 3);
  for (const p of r.frames) {
    const st = await stat(p);
    assert.ok(st.size > 1000, `${p} too small`);
  }
});

test("generate-proxy renders a 480w review copy", async () => {
  const r = await generateProxy(SILENCE);
  const st = await stat(r.proxy);
  assert.ok(st.size > 0);
  const info = await inspectFile(r.proxy);
  assert.equal(info.video?.width, 480);
  assert.ok(Math.abs(info.duration - 8) < 0.3);
});

test("full M2 loop: detect-silence -> plan --cuts-from -> validate -> preview", async () => {
  // 1. observation
  const report = await detectSilence(SILENCE, { thresholdDb: 35, minDurationSec: 0.5 });
  await writeFile("silence.json", JSON.stringify(report));

  // 2. scaffold a plan from the observation via the CLI bin
  const bin = path.resolve(import.meta.dirname, "..", "cli", "index.js");
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [
      bin, "plan", SILENCE, "--cuts-from", "silence.json", "--pad", "0.25",
    ]);
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d));
    child.stderr.on("data", (d: Buffer) => (err += d));
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(err))));
  });
  const plan = JSON.parse(stdout) as {
    operations: { type: string; start: number; end: number }[];
    output: { path: string };
  };
  // trim(0,8) + cut(~3.25, ~4.75)
  assert.equal(plan.operations[0]?.type, "trim");
  const cut = plan.operations[1]!;
  assert.equal(cut.type, "cut");
  assert.ok(Math.abs(cut.start - 3.25) < 0.2, `cut start ${cut.start}`);
  assert.ok(Math.abs(cut.end - 4.75) < 0.2, `cut end ${cut.end}`);
  plan.output.path = "edited.mp4";
  await writeFile("plan.json", JSON.stringify(plan));

  // 3. validate: 8s minus the padded gap (~1.5s) = ~6.5s
  const v = await validatePlan("plan.json");
  assert.equal(v.valid, true, JSON.stringify(v.errors));
  assert.ok(Math.abs((v.timelineDuration ?? 0) - 6.5) < 0.4, `timeline ${v.timelineDuration}`);

  // 4. preview renders
  const { renderPlan } = await import("../render/render.js");
  const rendered = await renderPlan("plan.json", { mode: "preview" });
  assert.ok(Math.abs(rendered.outputDuration - 6.5) < 0.5, `duration ${rendered.outputDuration}`);
});

test("plan --cuts-from rejects a malformed observation file", async () => {
  await writeFile("bad.json", JSON.stringify({ nope: true }));
  const bin = path.resolve(import.meta.dirname, "..", "cli", "index.js");
  const r = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [bin, "plan", SILENCE, "--cuts-from", "bad.json"]);
    let err = "";
    child.stderr.on("data", (d: Buffer) => (err += d));
    child.on("close", (code) => resolve({ code, stderr: err }));
  });
  assert.notEqual(r.code, 0);
  assert.ok(r.stderr.includes("OBSERVATION_INVALID"), r.stderr);
});
