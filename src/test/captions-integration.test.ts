import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCapture, inspectFile } from "../media/ffprobe.js";
import { validatePlan } from "../validate/validate.js";
import { renderPlan } from "../render/render.js";
import { generateCaptions } from "../captions/generate.js";
import { ToolError } from "../core/errors.js";

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

test("captions: -o out.vtt selects WebVTT (header, dot timestamps)", async () => {
  const r = await generateCaptions("transcript.json", { output: "plain.vtt" });
  assert.equal(r.cues, 3);
  assert.equal(r.remapped, false);
  assert.equal(r.dropped, 0);
  const vtt = await readFile("plain.vtt", "utf8");
  assert.ok(vtt.startsWith("WEBVTT\n\n"), vtt);
  assert.ok(vtt.includes("1\n00:00:00.000 --> 00:00:04.000\nFirst cue burns here"), vtt);
  assert.ok(!vtt.includes(","), "no SRT comma separator in timestamps");
  const st = await stat("plain.vtt");
  assert.ok(st.size > 0);
});

test("captions: --plan remap parity between srt and vtt", async () => {
  const args = { plan: "cutplan.json" } as const;
  const srt = await generateCaptions("transcript.json", { ...args, output: "parity.srt" });
  const vtt = await generateCaptions("transcript.json", { ...args, output: "parity.vtt" });
  assert.deepEqual(
    { cues: vtt.cues, dropped: vtt.dropped, remapped: vtt.remapped },
    { cues: srt.cues, dropped: srt.dropped, remapped: srt.remapped },
  );
  const [s, v] = await Promise.all([readFile("parity.srt", "utf8"), readFile("parity.vtt", "utf8")]);
  // fixture cue texts contain no commas: vtt body must equal the srt body
  // byte-for-byte with the millisecond separator swapped, under the header
  assert.equal(v, `WEBVTT\n\n${s.replace(/,/g, ".")}`);
});

test("captions: --format vtt overrides extension and drives the default name", async () => {
  const r = await generateCaptions("transcript.json", { format: "vtt" });
  assert.ok(r.output.endsWith(".vtt"), r.output);
  const vtt = await readFile(r.output, "utf8");
  assert.ok(vtt.startsWith("WEBVTT\n\n"));
  // explicit override rescues an otherwise-unknown extension
  const forced = await generateCaptions("transcript.json", { output: "forced.txt", format: "vtt" });
  assert.equal(forced.output, path.resolve("forced.txt"));
  assert.ok((await readFile("forced.txt", "utf8")).startsWith("WEBVTT\n\n"));
});

test("captions: unknown extension without --format -> OUTPUT_PATH_INVALID", async () => {
  await assert.rejects(
    () => generateCaptions("transcript.json", { output: "out.txt" }),
    (e: unknown) => e instanceof ToolError && e.code === "OUTPUT_PATH_INVALID",
  );
});

test("captions: bad --format value -> OPERATION_INVALID", async () => {
  await assert.rejects(
    () => generateCaptions("transcript.json", { format: "foo" }),
    (e: unknown) => e instanceof ToolError && e.code === "OPERATION_INVALID",
  );
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
