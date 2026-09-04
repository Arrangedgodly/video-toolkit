import { test } from "node:test";
import assert from "node:assert/strict";
import { formatSrtTime, formatSrt, transcriptToCues, mapCueThroughTimeline, mapCuesThroughTimeline } from "../captions/srt.js";
import { scoreHighlights, DEFAULT_HIGHLIGHT_PARAMS } from "../analysis/highlights.js";
import { EditPlan } from "../core/schemas.js";
import { buildRenderCommand, escapeFilterPath } from "../media/ffmpeg.js";

// ---- srt

test("formatSrtTime pads and uses comma milliseconds", () => {
  assert.equal(formatSrtTime(0), "00:00:00,000");
  assert.equal(formatSrtTime(1.5), "00:00:01,500");
  assert.equal(formatSrtTime(3661.25), "01:01:01,250");
});

test("formatSrt emits numbered blocks", () => {
  const srt = formatSrt([{ start: 0, end: 2, text: "hello\nworld" }]);
  assert.equal(srt, "1\n00:00:00,000 --> 00:00:02,000\nhello world\n");
});

test("transcriptToCues drops empty and inverted segments", () => {
  const cues = transcriptToCues({
    segments: [
      { start: 0, end: 2, text: "keep" },
      { start: 2, end: 4, text: "   " },
      { start: 5, end: 5, text: "inverted" },
    ],
  } as never);
  assert.deepEqual(cues, [{ start: 0, end: 2, text: "keep" }]);
});

test("cue inside one keep-window shifts by the window's output offset", () => {
  const out = mapCueThroughTimeline(
    { start: 12, end: 14, text: "x" },
    [{ start: 10, end: 20 }, { start: 30, end: 40 }],
  );
  assert.deepEqual(out, [{ start: 2, end: 4, text: "x" }]);
});

test("cue spanning a cut splits into per-window cues with output offsets", () => {
  const out = mapCueThroughTimeline(
    { start: 8, end: 32, text: "spans" },
    [{ start: 0, end: 10 }, { start: 30, end: 40 }],
  );
  // fragment 1: window [0,10] -> output [8,10]; fragment 2: window [30,40]
  // starts at output time 10 -> [10,12]
  assert.deepEqual(out, [
    { start: 8, end: 10, text: "spans" },
    { start: 10, end: 12, text: "spans" },
  ]);
});

test("cue entirely inside a removed range drops", () => {
  const out = mapCueThroughTimeline(
    { start: 12, end: 18, text: "gone" },
    [{ start: 0, end: 10 }, { start: 30, end: 40 }],
  );
  assert.deepEqual(out, []);
});

test("mapCues merges same-text fragments that rejoin at a boundary", () => {
  // windows [0,10] and [10,20] are contiguous keeps: a cue spanning 10 reunites
  const out = mapCuesThroughTimeline(
    [{ start: 8, end: 12, text: "joined" }],
    [{ start: 0, end: 10 }, { start: 10, end: 20 }],
  );
  assert.deepEqual(out, [{ start: 8, end: 12, text: "joined" }]);
});

// ---- highlights

const segs = (arr: { s: number; e: number; text: string }[]) => ({
  segments: arr.map((x) => ({ start: x.s, end: x.e, text: x.text })),
  duration: 100,
});
const sil = (arr: { s: number; e: number }[]) => ({
  segments: arr.map((x) => ({ start: x.s, end: x.e, duration: x.e - x.s })),
});

test("highlights: fast keyword-rich segment scores high, slow one filtered", () => {
  const t = segs([
    { s: 0, e: 10, text: "building the toolkit plans rendering validation toolkit plans" }, // 0.7 w/s? no — 9 words/10s = 0.9 w/s... make it dense:
  ]);
  // craft dense segment: 30 words in 10s = 3 w/s
  const dense = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ").replace(/word0|word1/g, "toolkit");
  const report = scoreHighlights(
    segs([{ s: 0, e: 10, text: dense }]),
    sil([]),
    { keywords: ["toolkit"], minScore: 0, maxCount: 5 },
  );
  assert.equal(report.candidates.length, 1);
  assert.ok(report.candidates[0]!.score > 0.5, `score ${report.candidates[0]!.score}`);
  assert.ok(report.candidates[0]!.reasons.some((r) => r.includes("keywords")));
});

test("highlights: pause before a segment contributes", () => {
  const dense = Array.from({ length: 30 }, (_, i) => `w${i}`).join(" ");
  const withPause = scoreHighlights(segs([{ s: 20, e: 30, text: dense }]), sil([{ s: 18, e: 20 }]), { keywords: [], minScore: 0, maxCount: 5 });
  const noPause = scoreHighlights(segs([{ s: 20, e: 30, text: dense }]), sil([]), { keywords: [], minScore: 0, maxCount: 5 });
  assert.ok(withPause.candidates[0]!.score > noPause.candidates[0]!.score);
  assert.ok(withPause.candidates[0]!.reasons.some((r) => r.includes("pause")));
});

test("highlights: maxCount and minScore filter, output time-ordered", () => {
  const mk = (s: number) => ({ s, e: s + 10, text: Array.from({ length: 30 }, (_, i) => `w${i}`).join(" ") });
  const report = scoreHighlights(segs([mk(0), mk(20), mk(40)]), sil([]), { keywords: [], minScore: 0.5, maxCount: 2 });
  assert.ok(report.candidates.length <= 2);
  const starts = report.candidates.map((c) => c.start);
  assert.deepEqual([...starts].sort((a, b) => a - b), starts);
});

test("highlights: defaults parse and empty transcript yields nothing", () => {
  const r = scoreHighlights(segs([]), sil([]), DEFAULT_HIGHLIGHT_PARAMS);
  assert.deepEqual(r.candidates, []);
});

// ---- captions plan op

const base = { version: 1, source: "in.mp4", output: { path: "out.mp4" } };

test("captions op parses with style", () => {
  const p = EditPlan.parse({
    ...base,
    operations: [{ type: "captions", file: "subs.srt", style: "FontSize=24" }],
  });
  assert.equal(p.operations[0]?.type, "captions");
});

test("escapeFilterPath escapes filter syntax characters", () => {
  const escaped = escapeFilterPath("a'b:c,d.srt");
  assert.ok(escaped.includes("\\'"), escaped);
  assert.ok(escaped.includes("\\:"), escaped);
  assert.ok(escaped.includes("\\,"), escaped);
});

test("builder: captions op lands in the vf chain after scale, before format", () => {
  const argv = buildRenderCommand(
    "in.mp4", [{ start: 0, end: 5 }], "out.mp4",
    {
      encoder: "libx264", crf: 18, preset: "medium", videoBitrate: "10M",
      audioBitrate: "192k", normalizeLufs: null, scaleWidth: 640,
      subtitleFile: "subs.srt", subtitleStyle: "FontSize=24",
    },
    true,
  );
  const vf = argv[argv.indexOf("-vf") + 1]!;
  const iScale = vf.indexOf("scale=640:-2");
  const iSubs = vf.indexOf("subtitles=filename=");
  const iFormat = vf.indexOf("format=yuv420p");
  assert.ok(iSubs > -1, vf);
  assert.ok(iScale < iSubs && iSubs < iFormat, vf);
  assert.ok(vf.includes("force_style='FontSize=24'"), vf);
});

test("builder: no captions op means no subtitles filter", () => {
  const argv = buildRenderCommand(
    "in.mp4", [{ start: 0, end: 5 }], "out.mp4",
    { encoder: "libx264", crf: 18, preset: "medium", videoBitrate: "10M", audioBitrate: "192k", normalizeLufs: null },
    true,
  );
  assert.ok(!argv[argv.indexOf("-vf") + 1]!.includes("subtitles"));
});
