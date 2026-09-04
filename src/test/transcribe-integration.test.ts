import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCapture } from "../media/ffprobe.js";
import { transcribeInput } from "../analysis/transcribe/index.js";
import { findHandy } from "../analysis/transcribe/handy.js";
import { detectFillerInstances } from "../analysis/filler.js";

// Real end-to-end: macOS `say` speech muxed into an mp4, transcribed by the
// installed engine. Skips (not fails) when no engine is present.
// Detection runs at module load (top-level await) so skip flags see it.
const FIXTURE = "speech.mp4";
let dir = "";
const handyAvailable = (await findHandy()) !== null;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "video-toolkit-m4-"));
  process.chdir(dir);

  const sayOk = await runCapture("say", [
    "-o", "speech.aiff",
    "Um, so basically this is the video toolkit transcription test. You know, it should find these words.",
  ]);
  if (sayOk.code !== 0) return; // no `say` on this machine — tests below skip

  const r = await runCapture("ffmpeg", [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=c=navy:s=640x360:r=10:d=10",
    "-i", "speech.aiff",
    "-t", "10", "-c:v", "libx264", "-crf", "28", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-shortest", FIXTURE,
  ]);
  assert.equal(r.code, 0, r.stderr);
});

after(async () => {
  process.chdir(tmpdir());
  await rm(dir, { recursive: true, force: true });
});

test("transcribe: real speech -> timestamped segments (parakeet via handy)", { skip: !handyAvailable }, async () => {
  const report = await transcribeInput(FIXTURE, { chunkSeconds: 4 });
  assert.equal(report.engine, "handy");
  assert.ok((report.model ?? "").includes("parakeet"), report.model ?? "");
  assert.ok(report.segments.length >= 1, JSON.stringify(report));
  const text = report.segments.map((s) => s.text).join(" ").toLowerCase();
  assert.ok(text.includes("video toolkit") || text.includes("transcription"), `text: ${text}`);

  // segment times are window boundaries: sorted, inside duration, no overlap
  let prevEnd = 0;
  for (const s of report.segments) {
    assert.ok(s.start >= prevEnd - 0.001, `overlap at ${s.start}`);
    assert.ok(s.end > s.start);
    assert.ok(s.end <= (report.duration ?? Infinity) + 0.001);
    prevEnd = s.end;
  }

  // filler detection over the real transcript
  const fillers = detectFillerInstances(report);
  if (fillers.length > 0) {
    for (const inst of fillers) {
      assert.ok(inst.start < inst.end);
      assert.ok(inst.context.length > 0);
    }
  }
});

test("transcribe: --concurrency 2 byte-identical to sequential; cache key unchanged", { skip: !handyAvailable }, async () => {
  // 10 s fixture, chunk 3 -> 4 windows: the parallel run genuinely overlaps
  const par = await transcribeInput(FIXTURE, { chunkSeconds: 3, concurrency: 2 }); // miss -> writes cache
  const lines: string[] = [];
  const hit = await transcribeInput(FIXTURE, {
    chunkSeconds: 3,
    concurrency: 2,
    debug: (l) => lines.push(l),
  });
  const seq = await transcribeInput(FIXTURE, { chunkSeconds: 3, noCache: true }); // recompute sequentially
  assert.equal(JSON.stringify(par), JSON.stringify(seq), "parallel report must be byte-identical");
  assert.ok(
    lines.some((l) => l.includes("cache hit: transcript-handy")),
    lines.join("; "),
  );
});

test("transcribe: no audio stream -> empty report with note", { skip: !handyAvailable }, async () => {
  const r = await runCapture("ffmpeg", [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=10",
    "-t", "2", "-c:v", "libx264", "-crf", "28", "silent.mp4",
  ]);
  assert.equal(r.code, 0, r.stderr);
  const report = await transcribeInput("silent.mp4");
  assert.equal(report.segments.length, 0);
  assert.equal(report.note, "no audio stream");
});

test("detect-filler works from a saved transcript file", async () => {
  const { TranscriptReport } = await import("../core/schemas.js");
  const doc = TranscriptReport.parse({
    segments: [{ start: 0, end: 6, text: "Um so we built it, you know" }],
  });
  await writeFile("t.json", JSON.stringify(doc));
  const instances = detectFillerInstances(doc);
  const phrases = instances.map((i) => i.phrase);
  assert.ok(phrases.includes("um"));
  assert.ok(phrases.includes("you know"));
});
