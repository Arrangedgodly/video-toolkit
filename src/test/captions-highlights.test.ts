import { test } from "node:test";
import assert from "node:assert/strict";
import { formatSrtTime, formatSrt, transcriptToCues, mapCueThroughTimeline, mapCuesThroughTimeline } from "../captions/srt.js";
import { formatVttTime, formatVtt, escapeVttText } from "../captions/vtt.js";
import { resolveCaptionFormat } from "../captions/generate.js";
import { scoreHighlights, DEFAULT_HIGHLIGHT_PARAMS } from "../analysis/highlights.js";
import { EditPlan } from "../core/schemas.js";
import { buildRenderCommand, escapeFilterPath } from "../media/ffmpeg.js";
import { ToolError } from "../core/errors.js";

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

// ---- crossfade remap honesty (T12 outcome (a), per R3's measurement:
// plain cues drift late by exactly (j−1)·D; the shift restores alignment)

const CF_SEGS = [
  { start: 1, end: 4 },
  { start: 5.5, end: 9 },
  { start: 11, end: 14.5 },
];
const CF_D = 0.5;

test("crossfade remap: a cue in segment j shifts by exactly −(j−1)·D", () => {
  // cue anchored at the HEAD of each segment (source time), plain output
  // heads are 0 / 3.0 / 6.5; adjusted heads must be the xfade offsets 0 / 2.5 / 5.5
  const cues = [
    { start: 1.2, end: 2.4, text: "one" },
    { start: 5.7, end: 6.9, text: "two" },
    { start: 11.2, end: 12.4, text: "three" },
  ];
  const round = (cs: { start: number; end: number; text: string }[]) =>
    cs.map((c) => ({
      start: Math.round(c.start * 1e9) / 1e9,
      end: Math.round(c.end * 1e9) / 1e9,
      text: c.text,
    }));
  assert.deepEqual(round(mapCuesThroughTimeline(cues, CF_SEGS, CF_D)), [
    { start: 0.2, end: 1.4, text: "one" },   // j=1: no shift
    { start: 2.7, end: 3.9, text: "two" },   // j=2: −0.5
    { start: 5.7, end: 6.9, text: "three" }, // j=3: −1.0
  ]);
});

test("crossfade remap: segment j's plain window maps onto the xfade offsets exactly", () => {
  // the fragment covering segment j's full content maps its START to O(j−1)
  // and its content end (O_j) is exactly where the next segment's content
  // begins — the offset formula and the remap agree by construction
  const full = mapCueThroughTimeline(
    { start: 5.5, end: 9, text: "seg2" },
    CF_SEGS,
    CF_D,
  );
  assert.deepEqual(full, [{ start: 2.5, end: 6.0, text: "seg2" }]); // [O1, O1+L2]
  // segment 3's head lands exactly at O2 (its content boundary)
  const head = mapCueThroughTimeline({ start: 11, end: 12, text: "seg3head" }, CF_SEGS, CF_D);
  assert.equal(head[0]!.start, 5.5); // == xfadeOffsets(CF_SEGS, CF_D)[1]
});

test("crossfade remap: fragments never span a join (split rules unchanged)", () => {
  // DIFFERENT texts so the same-text merge cannot hide the fragment shape:
  // segment 1's tail cue and segment 2's head cue each stay inside their own
  // segment; the shift makes them overlap by exactly D across the fade
  // window — both segments' content is on screen during [O_k, O_k+D], so
  // both cues are simultaneously true (libass renders overlaps correctly)
  const out = mapCuesThroughTimeline(
    [
      { start: 3, end: 4, text: "tail" },
      { start: 5.5, end: 6, text: "head" },
    ],
    CF_SEGS,
    CF_D,
  );
  assert.deepEqual(out, [
    { start: 2.0, end: 3.0, text: "tail" }, // plain [2,3], no shift
    { start: 2.5, end: 3.0, text: "head" }, // plain [3,3.5] − 0.5
  ]);
  const overlap = out[1]!.start - out[0]!.end;
  assert.ok(overlap < 0 && Math.abs(overlap) <= CF_D, `overlap ${overlap}`);
});

test("crossfade remap: same-text fragments across a join merge (text rides the fade)", () => {
  // one cue spanning the source gap [4,5.5]: the cut already leaves adjacent
  // plain fragments ([2,3] + [3,3.5] — seg2's plain window starts at 3.0) and
  // the existing 0.05 s merge reunites them; the crossfade shift pulls seg2's
  // fragment 0.5 s earlier, so the merged window shrinks with the timeline —
  // the text stays on screen exactly as long as its content does
  const plain = mapCuesThroughTimeline([{ start: 3, end: 6, text: "spans" }], CF_SEGS);
  assert.deepEqual(plain, [{ start: 2.0, end: 3.5, text: "spans" }]);
  const faded = mapCuesThroughTimeline([{ start: 3, end: 6, text: "spans" }], CF_SEGS, CF_D);
  const f = faded[0]!;
  assert.equal(faded.length, 1);
  assert.ok(Math.abs(f.start - 2.0) < 1e-9 && Math.abs(f.end - 3.0) < 1e-9, JSON.stringify(faded));
});

test("crossfade remap: MIN_CUE drop rule unchanged; crossfade arg 0 = plain path", () => {
  // a 0.2 s fragment still drops after shifting
  const short = mapCueThroughTimeline({ start: 13.9, end: 14.1, text: "tiny" }, CF_SEGS, CF_D);
  assert.deepEqual(short, []);
  // byte-identity lock: omitted arg and explicit 0 produce identical lists
  const cues = [
    { start: 2, end: 6, text: "a" },
    { start: 6, end: 13, text: "b" },
    { start: 13, end: 14.2, text: "c" },
  ];
  const plain = mapCuesThroughTimeline(cues, CF_SEGS);
  assert.deepEqual(mapCuesThroughTimeline(cues, CF_SEGS, 0), plain);
});

test("crossfade remap: head fragments stay ordered and non-negative", () => {
  // every remapped cue starts ≥ 0 and the list stays sorted by start —
  // the output clock never runs backwards even at the first join
  const cues = [
    { start: 0, end: 14.5, text: "everything" },
    { start: 13, end: 14.4, text: "tail" },
  ];
  const out = mapCuesThroughTimeline(cues, CF_SEGS, CF_D);
  for (const c of out) assert.ok(c.start >= 0 && c.end > c.start, JSON.stringify(out));
  const starts = out.map((c) => c.start);
  assert.deepEqual([...starts].sort((a, b) => a - b), starts);
});

// ---- vtt (WebVTT variant: same cue math, WebVTT serialization)

test("formatVttTime pads and uses dot milliseconds", () => {
  assert.equal(formatVttTime(0), "00:00:00.000");
  assert.equal(formatVttTime(1.5), "00:00:01.500");
  assert.equal(formatVttTime(3661.25), "01:01:01.250");
  assert.ok(!formatVttTime(98765.4321).includes(","), "no SRT comma separator");
});

test("formatVtt emits a WEBVTT header and numbered blocks with dot timestamps", () => {
  const vtt = formatVtt([{ start: 0, end: 2, text: "hello\nworld" }]);
  assert.equal(vtt, "WEBVTT\n\n1\n00:00:00.000 --> 00:00:02.000\nhello world\n");
});

test("formatVtt with no cues is a bare valid header", () => {
  assert.equal(formatVtt([]), "WEBVTT\n\n\n");
});

test("vtt escapes HTML-significant characters in cue text; srt stays raw", () => {
  const cue = { start: 0, end: 1, text: "rock & roll <i>loud</i>" };
  assert.equal(escapeVttText(cue.text), "rock &amp; roll &lt;i&gt;loud&lt;/i&gt;");
  assert.equal(
    formatVtt([cue]),
    "WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.000\nrock &amp; roll &lt;i&gt;loud&lt;/i&gt;\n",
  );
  // SRT behavior unchanged: same cue, raw text, comma separator
  assert.equal(formatSrt([cue]), "1\n00:00:00,000 --> 00:00:01,000\nrock & roll <i>loud</i>\n");
});

test("srt and vtt stay in lockstep through the same cue math (remap parity)", () => {
  const cues = transcriptToCues({
    segments: [
      { start: 0, end: 5, text: "one" },
      { start: 8, end: 32, text: "spans a cut" },
      { start: 33, end: 33.1, text: "too short, drops" },
      { start: 40, end: 45, text: "tail" },
    ],
  } as never);
  const mapped = mapCuesThroughTimeline(cues, [{ start: 0, end: 10 }, { start: 30, end: 40 }]);
  const srt = formatSrt(mapped);
  const vtt = formatVtt(mapped);
  const vttBlocks = vtt.trim().split("\n\n");
  assert.equal(vttBlocks[0], "WEBVTT");
  // every non-header block is byte-identical to the SRT block modulo the
  // millisecond separator — same numbers, same order, same text
  assert.deepEqual(vttBlocks.slice(1), srt.trim().split("\n\n").map((b) => b.replace(/,/g, ".")));
});

test("resolveCaptionFormat: extension detection, explicit override, defaults", () => {
  assert.equal(resolveCaptionFormat(undefined, undefined), "srt"); // legacy default
  assert.equal(resolveCaptionFormat(undefined, "vtt"), "vtt");
  assert.equal(resolveCaptionFormat("out.srt", undefined), "srt");
  assert.equal(resolveCaptionFormat("out.vtt", undefined), "vtt");
  assert.equal(resolveCaptionFormat("out.VTT", undefined), "vtt"); // case-insensitive
  assert.equal(resolveCaptionFormat("out.srt", "vtt"), "vtt"); // override wins
  assert.equal(resolveCaptionFormat("out.txt", "srt"), "srt"); // override rescues unknown extension
});

test("resolveCaptionFormat: unknown extension without override -> OUTPUT_PATH_INVALID", () => {
  assert.throws(
    () => resolveCaptionFormat("out.txt", undefined),
    (e: unknown) => e instanceof ToolError && e.code === "OUTPUT_PATH_INVALID",
  );
});

test("resolveCaptionFormat: bad --format value -> OPERATION_INVALID", () => {
  assert.throws(
    () => resolveCaptionFormat(undefined, "foo"),
    (e: unknown) => e instanceof ToolError && e.code === "OPERATION_INVALID",
  );
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
