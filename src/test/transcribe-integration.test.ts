import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import { accessSync, constants } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCapture } from "../media/ffprobe.js";
import { transcribeInput } from "../analysis/transcribe/index.js";
import { findHandy } from "../analysis/transcribe/handy.js";
import { findWhisperCli, resolveWhisperModel } from "../analysis/transcribe/whisper.js";
import { detectFillerInstances } from "../analysis/filler.js";

// Real end-to-end: macOS `say` speech muxed into an mp4, transcribed by the
// installed engine. Skips (not fails) when no engine is present.
// Detection runs at module load (top-level await) so skip flags see it.
const FIXTURE = "speech.mp4";
let dir = "";
const handyAvailable = (await findHandy()) !== null;
// whisper-cpp guard: binary on PATH AND the provisioned model resolvable
// (module-load cwd = repo root, where .video-agent/models lives) AND `say`
// present (skip flags are evaluated at registration, so the speech fixture
// readiness itself cannot gate them — probe the binary instead)
const whisperBin = await findWhisperCli();
const whisperModel = resolveWhisperModel();
const whisperModelAbs = whisperModel !== null ? path.resolve(whisperModel) : null;
const sayAvailable = (process.env.PATH ?? "").split(path.delimiter).some((d) => {
  if (!d) return false;
  try {
    accessSync(path.join(d, "say"), constants.X_OK);
    return true;
  } catch {
    return false;
  }
});
const whisperAvailable = whisperBin !== null && whisperModel !== null && sayAvailable;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "video-toolkit-m4-"));
  process.chdir(dir);

  const sayOk = await runCapture("say", [
    "-o", "speech.aiff",
    "Um, so basically this is the video toolkit transcription test. You know, it should find these words.",
  ]);
  if (sayOk.code !== 0) return; // no `say` on this machine — tests below skip

  // rule 3 of the model-resolution table, exercised for real in the tmp cwd:
  // symlink the provisioned model into ./.video-agent/models/ — target is
  // absolute, resolved at MODULE LOAD (cwd = repo root), before any chdir
  if (whisperModelAbs) {
    await mkdir(path.join(".video-agent", "models"), { recursive: true });
    await symlink(whisperModelAbs, path.join(".video-agent", "models", "ggml-base.en.bin"));
  }

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

// ---- T10: real whisper-cpp engine (skip without whisper-cli AND the model) ----

test("transcribe: whisper-cpp --word-timestamps -> segments WITH words (real engine)", { skip: !whisperAvailable }, async () => {
  const report = await transcribeInput(FIXTURE, {
    engine: "whisper-cpp",
    wordTimestamps: true,
    chunkSeconds: 3, // must be IGNORED (native segments — no windowing)
    concurrency: 4, // must be IGNORED (one whole-file invocation)
  });
  assert.equal(report.engine, "whisper-cpp");
  assert.ok((report.model ?? "").includes("ggml-base.en"), report.model ?? "");
  assert.equal(report.language, "en");
  assert.equal(report.params?.wordTimestamps, true);
  assert.equal(report.params?.chunkSeconds, undefined); // windowing facts absent on the native path
  assert.ok(report.segments.length >= 1, JSON.stringify(report));

  const text = report.segments.map((s) => s.text).join(" ").toLowerCase();
  assert.ok(text.includes("toolkit") || text.includes("transcription"), `text: ${text}`);

  // words present on EVERY segment, ordered, non-overlapping, within bounds
  let totalWords = 0;
  for (const seg of report.segments) {
    assert.ok(seg.words && seg.words.length >= 1, `no words on ${JSON.stringify(seg)}`);
    let prevEnd = seg.start;
    for (const w of seg.words!) {
      assert.ok(w.text.length > 0, "empty word text");
      assert.ok(w.start >= prevEnd - 0.001, `word overlap at ${w.start} after ${prevEnd}: ${w.text}`);
      assert.ok(w.end >= w.start, `negative span: ${w.text}`);
      assert.ok(w.start >= seg.start - 0.001 && w.end <= seg.end + 0.001, `out of segment bounds: ${w.text}`);
      prevEnd = w.end;
      totalWords++;
    }
  }
  assert.ok(totalWords >= 10, `only ${totalWords} words`);

  // the merged word text must reconstruct the segment text (merge contract)
  for (const seg of report.segments) {
    const joined = seg.words!.map((w) => w.text).join(" ").replace(/\s+([,.!?'])/g, "$1");
    assert.equal(joined, seg.text, "words must reconstruct the segment text");
  }
});

test("transcribe: --word-timestamps with no --engine selects whisper-cpp (real engine)", { skip: !whisperAvailable }, async () => {
  const report = await transcribeInput(FIXTURE, { wordTimestamps: true });
  assert.equal(report.engine, "whisper-cpp");
  assert.ok(report.segments.every((s) => s.words && s.words.length >= 1));
});

test("transcribe: whisper-cpp without --word-timestamps -> segments, no words; cache keys differ per flag", { skip: !whisperAvailable }, async () => {
  const plain = await transcribeInput(FIXTURE, { engine: "whisper-cpp" });
  assert.equal(plain.engine, "whisper-cpp");
  assert.ok(plain.segments.length >= 1);
  assert.ok(plain.segments.every((s) => !("words" in s))); // segments only — no words key
  assert.equal(plain.params?.wordTimestamps, false);

  // warm cache: words entry HIT, words-less entry was a separate MISS+write
  const w1lines: string[] = [];
  const hit = await transcribeInput(FIXTURE, {
    engine: "whisper-cpp",
    wordTimestamps: true,
    debug: (l) => w1lines.push(l),
  });
  assert.ok(
    w1lines.some((l) => l.includes("cache hit: transcript-whisper-cpp-default-c0-w1.json")),
    w1lines.join("; "),
  );
  assert.ok(hit.segments.every((s) => s.words && s.words.length >= 1));
});
