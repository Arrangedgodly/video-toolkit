import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCapture, inspectFile } from "../media/ffprobe.js";
import { validatePlan } from "../validate/validate.js";
import { renderPlan } from "../render/render.js";
import { generateCaptions } from "../captions/generate.js";

const FIXTURE = "fixture.mp4"; // 10s
let dir = "";

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "video-toolkit-m5-"));
  process.chdir(dir);
  const r = await runCapture("ffmpeg", [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30",
    "-f", "lavfi", "-i", "sine=frequency=440",
    "-t", "10", "-c:v", "libx264", "-crf", "23", "-pix_fmt", "yuv420p",
    "-c:a", "aac", FIXTURE,
  ]);
  assert.equal(r.code, 0, r.stderr);

  await writeFile("transcript.json", JSON.stringify({
    segments: [
      { start: 0, end: 4, text: "First cue burns here" },
      { start: 4, end: 7, text: "Second cue" },
      { start: 7, end: 10, text: "Third cue" },
    ],
    duration: 10,
  }));
});

after(async () => {
  process.chdir(tmpdir());
  await rm(dir, { recursive: true, force: true });
});

test("captions: transcript -> srt (source times)", async () => {
  const r = await generateCaptions("transcript.json");
  assert.equal(r.cues, 3);
  assert.equal(r.remapped, false);
  const st = await stat(r.output);
  assert.ok(st.size > 0);
});

test("captions: --plan remaps cue times through cuts", async () => {
  await writeFile("cutplan.json", JSON.stringify({
    version: 1,
    source: FIXTURE,
    operations: [
      { type: "trim", start: 0, end: 10 },
      { type: "cut", start: 4, end: 7 },
    ],
    output: { path: "cut.mp4", mode: "final" },
  }));
  const r = await generateCaptions("transcript.json", { plan: "cutplan.json", output: "cut.srt" });
  assert.equal(r.remapped, true);
  // second cue lived entirely inside the removed range
  assert.equal(r.cues, 2);
  assert.equal(r.dropped, 1);
});

test("render: burned captions produce a valid, visibly different encode", async () => {
  await generateCaptions("transcript.json", { output: "burn.srt" });
  await writeFile("burnplan.json", JSON.stringify({
    version: 1,
    source: FIXTURE,
    operations: [
      { type: "trim", start: 0, end: 10 },
      { type: "captions", file: "burn.srt" },
    ],
    output: { path: "burned.mp4", mode: "final" },
  }));
  const v = await validatePlan("burnplan.json");
  assert.equal(v.valid, true, JSON.stringify(v.errors));

  const bare = await renderPlan("burnplan.json");
  const info = await inspectFile(bare.output);
  assert.ok(Math.abs(info.duration - 10) < 0.3);

  // same plan without captions: encoded bytes must differ (text is on frames)
  await writeFile("noburn.json", JSON.stringify({
    version: 1,
    source: FIXTURE,
    operations: [{ type: "trim", start: 0, end: 10 }],
    output: { path: "plain.mp4", mode: "final" },
  }));
  const plain = await renderPlan("noburn.json");
  const [a, b] = await Promise.all([
    (await import("node:fs/promises")).readFile(bare.output),
    (await import("node:fs/promises")).readFile(plain.output),
  ]);
  assert.ok(!a.equals(b), "captioned and plain encodes are byte-identical");
});

test("validate: missing srt file -> OPERATION_INVALID", async () => {
  await writeFile("badcap.json", JSON.stringify({
    version: 1,
    source: FIXTURE,
    operations: [
      { type: "trim", start: 0, end: 5 },
      { type: "captions", file: "nope.srt" },
    ],
    output: { path: "x.mp4", mode: "final" },
  }));
  const r = await validatePlan("badcap.json");
  assert.equal(r.valid, false);
  assert.equal(r.errors[0]?.code, "OPERATION_INVALID");
  assert.ok(r.errors[0]?.message.includes("nope.srt"));
});

test("validate: duplicate captions op -> OPERATION_INVALID", async () => {
  await generateCaptions("transcript.json", { output: "burn.srt" });
  await writeFile("dupcap.json", JSON.stringify({
    version: 1,
    source: FIXTURE,
    operations: [
      { type: "trim", start: 0, end: 5 },
      { type: "captions", file: "burn.srt" },
      { type: "captions", file: "burn.srt" },
    ],
    output: { path: "y.mp4", mode: "final" },
  }));
  const r = await validatePlan("dupcap.json");
  assert.equal(r.errors[0]?.code, "OPERATION_INVALID");
  assert.equal(r.errors[0]?.operation, 3);
});
