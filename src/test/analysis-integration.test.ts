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

const cliBin = () => path.resolve(import.meta.dirname, "..", "cli", "index.js");

function runCli<T>(...args: string[]): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliBin(), ...args]);
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d));
    child.stderr.on("data", (d: Buffer) => (err += d));
    child.on("close", (code) => (code === 0 ? resolve(JSON.parse(out) as T) : reject(new Error(err))));
  });
}

function runCliExpectError(...args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliBin(), ...args]);
    let err = "";
    child.stderr.on("data", (d: Buffer) => (err += d));
    child.on("close", (code) => resolve({ code, stderr: err }));
  });
}

const highlightReport = (cs: { start: number; end: number; score: number }[]) => ({
  candidates: cs.map((c) => ({
    ...c,
    text: `moment at ${c.start}`,
    reasons: ["test"],
  })),
});

test("plan --highlights-from scaffolds a valid trim compilation", async () => {
  await writeFile(
    "highlights.json",
    JSON.stringify(
      highlightReport([
        { start: 0.5, end: 2.5, score: 0.8 },
        { start: 5.5, end: 7.5, score: 0.6 },
        { start: 3.0, end: 3.5, score: 0.2 }, // below the min-score floor
      ]),
    ),
  );
  const plan = await runCli<{
    operations: { type: string; start: number; end: number }[];
    output: { path: string };
  }>("plan", SILENCE, "--highlights-from", "highlights.json");
  // whole-source trim replaced by the two qualifying candidates, padded 0.5s
  assert.equal(plan.operations.length, 2, JSON.stringify(plan.operations));
  assert.deepEqual(plan.operations[0], { type: "trim", start: 0, end: 3 });
  const second = plan.operations[1]!;
  assert.equal(second.type, "trim");
  assert.ok(Math.abs(second.start - 5) < 0.01, `start ${second.start}`);
  assert.ok(Math.abs(second.end - 8) < 0.05, `end ${second.end}`);

  plan.output.path = "highlights.mp4";
  await writeFile("highlights-plan.json", JSON.stringify(plan));
  const v = await validatePlan("highlights-plan.json");
  assert.equal(v.valid, true, JSON.stringify(v.errors));
  assert.ok(Math.abs((v.timelineDuration ?? 0) - 6) < 0.1, `timeline ${v.timelineDuration}`);
});

test("plan --highlights-from honors --count, --min-score and --pad", async () => {
  await writeFile(
    "highlights-count.json",
    JSON.stringify(
      highlightReport([
        { start: 0.5, end: 2.5, score: 0.8 },
        { start: 5.5, end: 7.5, score: 0.6 },
        { start: 3.0, end: 3.5, score: 0.2 },
      ]),
    ),
  );
  const plan = await runCli<{ operations: { type: string; start: number; end: number }[] }>(
    "plan",
    SILENCE,
    "--highlights-from",
    "highlights-count.json",
    "--count",
    "1",
    "--min-score",
    "0.3",
    "--pad",
    "0",
  );
  // top-1 by score, no pad, floor low enough for all three candidates
  assert.deepEqual(plan.operations, [{ type: "trim", start: 0.5, end: 2.5 }]);
});

test("plan --highlights-from with no qualifying candidate keeps the whole-source scaffold", async () => {
  await writeFile("empty-highlights.json", JSON.stringify(highlightReport([])));
  const plan = await runCli<{ operations: { type: string; start: number; end: number }[] }>(
    "plan",
    SILENCE,
    "--highlights-from",
    "empty-highlights.json",
  );
  assert.equal(plan.operations.length, 1);
  assert.equal(plan.operations[0]!.type, "trim");
  assert.equal(plan.operations[0]!.start, 0);
});

test("plan --highlights-from rejects a malformed highlights file", async () => {
  await writeFile("bad-highlights.json", JSON.stringify({ segments: [] })); // silence-shaped
  const r = await runCliExpectError("plan", SILENCE, "--highlights-from", "bad-highlights.json");
  assert.notEqual(r.code, 0);
  assert.ok(r.stderr.includes("OBSERVATION_INVALID"), r.stderr);
});

test("plan rejects combining both bridges", async () => {
  await writeFile("bridge-silence.json", JSON.stringify({ segments: [] }));
  await writeFile("bridge-highlights.json", JSON.stringify(highlightReport([])));
  const r = await runCliExpectError(
    "plan",
    SILENCE,
    "--cuts-from",
    "bridge-silence.json",
    "--highlights-from",
    "bridge-highlights.json",
  );
  assert.notEqual(r.code, 0);
  assert.ok(r.stderr.includes("OPERATION_INVALID"), r.stderr);
});

const fillerReport = (is: { start: number; end: number }[]) => ({
  instances: is.map((i) => ({ ...i, phrase: "um", context: "so um yeah" })),
});

test("plan --cuts-from filler.json expands instances into cuts", async () => {
  await writeFile(
    "filler.json",
    JSON.stringify(fillerReport([{ start: 1.0, end: 1.4 }, { start: 6.0, end: 6.3 }])),
  );
  const plan = await runCli<{
    operations: { type: string; start: number; end: number }[];
    output: { path: string };
  }>("plan", SILENCE, "--cuts-from", "filler.json");
  // whole-source trim + one cut per instance, padded 0.1 before / 0.25 after
  assert.equal(plan.operations.length, 3, JSON.stringify(plan.operations));
  assert.equal(plan.operations[0]?.type, "trim");
  assert.deepEqual(plan.operations[1], { type: "cut", start: 0.9, end: 1.65 });
  assert.deepEqual(plan.operations[2], { type: "cut", start: 5.9, end: 6.55 });

  plan.output.path = "defiller.mp4";
  await writeFile("defiller-plan.json", JSON.stringify(plan));
  const v = await validatePlan("defiller-plan.json");
  assert.equal(v.valid, true, JSON.stringify(v.errors));
  // 8s source minus (0.75 + 0.65) of padded cuts
  assert.ok(Math.abs((v.timelineDuration ?? 0) - 6.6) < 0.01, `timeline ${v.timelineDuration}`);
});

test("plan --cuts-from filler.json honors the filler pads; silence --pad does not apply", async () => {
  await writeFile(
    "filler-pads.json",
    JSON.stringify(fillerReport([{ start: 1.0, end: 1.4 }, { start: 6.0, end: 6.3 }])),
  );
  const plan = await runCli<{ operations: { type: string; start: number; end: number }[] }>(
    "plan",
    SILENCE,
    "--cuts-from",
    "filler-pads.json",
    "--filler-pad-before",
    "0",
    "--filler-pad-end",
    "0",
    "--pad",
    "0.5", // silence-only: must leave the filler estimates untouched
  );
  assert.deepEqual(plan.operations.slice(1), [
    { type: "cut", start: 1, end: 1.4 },
    { type: "cut", start: 6, end: 6.3 },
  ]);
});

test("plan --cuts-from with an empty filler report keeps the whole-source scaffold", async () => {
  await writeFile("empty-filler.json", JSON.stringify(fillerReport([])));
  const plan = await runCli<{ operations: { type: string; start: number; end: number }[] }>(
    "plan",
    SILENCE,
    "--cuts-from",
    "empty-filler.json",
  );
  assert.equal(plan.operations.length, 1);
  assert.equal(plan.operations[0]?.type, "trim");
  assert.equal(plan.operations[0]?.start, 0);
});

test("plan --cuts-from rejects a report that is neither silence nor filler", async () => {
  await writeFile("bad-filler.json", JSON.stringify({ candidates: [] })); // highlight-shaped
  const r = await runCliExpectError("plan", SILENCE, "--cuts-from", "bad-filler.json");
  assert.notEqual(r.code, 0);
  assert.ok(r.stderr.includes("OBSERVATION_INVALID"), r.stderr);
});
