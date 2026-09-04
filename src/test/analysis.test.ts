import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSilenceOutput } from "../analysis/silence.js";
import { parseSceneOutput } from "../analysis/scenes.js";
import { silenceToCuts } from "../analysis/silence-to-cuts.js";
import { highlightsToTrims } from "../analysis/highlights-to-trims.js";
import { fillerToCuts } from "../analysis/filler-to-cuts.js";
import { planReviewGroups } from "../analysis/review-frames.js";
import {
  detectFillerInstances,
  DEFAULT_FILLER_PHRASES,
} from "../analysis/filler.js";

test("parseSilenceOutput pairs starts with ends in order", () => {
  const stderr = [
    "[silencedetect @ 0x1] silence_start: 3.0",
    "[silencedetect @ 0x1] silence_end: 5.0 | silence_duration: 2.0",
    "[silencedetect @ 0x1] silence_start: 9.5",
    "[silencedetect @ 0x1] silence_end: 12.0 | silence_duration: 2.5",
  ].join("\n");
  assert.deepEqual(parseSilenceOutput(stderr, 20), [
    { start: 3.0, end: 5.0 },
    { start: 9.5, end: 12.0 },
  ]);
});

test("trailing silence without an end marker runs to source duration", () => {
  const stderr = "[silencedetect @ 0x1] silence_start: 7.25";
  assert.deepEqual(parseSilenceOutput(stderr, 10), [{ start: 7.25, end: 10 }]);
});

test("silence end is clamped to source duration", () => {
  const stderr = [
    "silence_start: 8",
    "silence_end: 10.5 | silence_duration: 2.5",
  ].join("\n");
  assert.deepEqual(parseSilenceOutput(stderr, 9), [{ start: 8, end: 9 }]);
});

test("parseSceneOutput pairs pts_time with the following scene score", () => {
  const stderr = [
    "frame:88   pts:2816   pts_time:2.816",
    "lavfi.scene_score=0.874210",
    "frame:180  pts:5760   pts_time:5.76",
    "lavfi.scene_score=0.991234",
  ].join("\n");
  assert.deepEqual(parseSceneOutput(stderr), [
    { timestamp: 2.816, confidence: 0.87421 },
    { timestamp: 5.76, confidence: 0.991234 },
  ]);
});

test("scene score without a preceding time is ignored", () => {
  assert.deepEqual(parseSceneOutput("lavfi.scene_score=0.9"), []);
});

const report = (segs: { s: number; e: number }[]) => ({
  segments: segs.map((x) => ({ start: x.s, end: x.e, duration: x.e - x.s })),
});

test("silenceToCuts applies pad and min-duration", () => {
  const cuts = silenceToCuts(report([{ s: 3, e: 5 }, { s: 20, e: 20.3 }]), 30, {
    minDuration: 0.5,
    pad: 0.25,
  });
  assert.deepEqual(cuts, [{ type: "cut", start: 3.25, end: 4.75 }]);
});

test("silenceToCuts clamps to source bounds", () => {
  const cuts = silenceToCuts(report([{ s: 0, e: 2 }, { s: 28, e: 30 }]), 30, {
    minDuration: 0.5,
    pad: 0.25,
  });
  assert.deepEqual(cuts, [
    { type: "cut", start: 0.25, end: 1.75 },
    { type: "cut", start: 28.25, end: 29.75 },
  ]);
});

test("silenceToCuts drops gaps the pad fully consumes", () => {
  const cuts = silenceToCuts(report([{ s: 10, e: 10.4 }]), 30, {
    minDuration: 0.3,
    pad: 0.25,
  });
  assert.deepEqual(cuts, []);
});

test("silenceToCuts with zero pad cuts exact ranges", () => {
  const cuts = silenceToCuts(report([{ s: 3, e: 5 }]), 8, { minDuration: 0.5, pad: 0 });
  assert.deepEqual(cuts, [{ type: "cut", start: 3, end: 5 }]);
});

const highlights = (cs: { s: number; e: number; score: number }[]) => ({
  candidates: cs.map((c) => ({
    start: c.s,
    end: c.e,
    score: c.score,
    text: `segment at ${c.s}`,
    reasons: ["test"],
  })),
});

test("highlightsToTrims keeps the top candidates by score", () => {
  const trims = highlightsToTrims(
    highlights([
      { s: 0, e: 4, score: 0.5 },
      { s: 6, e: 10, score: 0.9 },
      { s: 12, e: 16, score: 0.7 },
    ]),
    20,
    { count: 2, minScore: 0.35, pad: 0 },
  );
  assert.deepEqual(trims, [
    { type: "trim", start: 6, end: 10 },
    { type: "trim", start: 12, end: 16 },
  ]);
});

test("score ties break toward the earlier candidate", () => {
  const trims = highlightsToTrims(
    highlights([
      { s: 10, e: 14, score: 0.8 },
      { s: 0, e: 4, score: 0.8 },
    ]),
    20,
    { count: 1, minScore: 0.35, pad: 0 },
  );
  assert.deepEqual(trims, [{ type: "trim", start: 0, end: 4 }]);
});

test("candidates below min-score are floored out", () => {
  const trims = highlightsToTrims(
    highlights([
      { s: 0, e: 4, score: 0.34 },
      { s: 6, e: 8, score: 0.35 },
    ]),
    20,
    { count: 5, minScore: 0.35, pad: 0 },
  );
  assert.deepEqual(trims, [{ type: "trim", start: 6, end: 8 }]);
});

test("pad expands each side and clamps to the source bounds", () => {
  const trims = highlightsToTrims(
    highlights([
      { s: 0.1, e: 1.9, score: 0.9 },
      { s: 6, e: 7.9, score: 0.8 },
    ]),
    8,
    { count: 5, minScore: 0.35, pad: 0.5 },
  );
  assert.deepEqual(trims, [
    { type: "trim", start: 0, end: 2.4 },
    { type: "trim", start: 5.5, end: 8 },
  ]);
});

test("overlapping candidates pass through for the trim-union math", () => {
  const trims = highlightsToTrims(
    highlights([
      { s: 2, e: 6, score: 0.9 },
      { s: 4, e: 9, score: 0.8 },
    ]),
    20,
    { count: 5, minScore: 0.35, pad: 0 },
  );
  assert.deepEqual(trims, [
    { type: "trim", start: 2, end: 6 },
    { type: "trim", start: 4, end: 9 },
  ]);
});

test("timestamps are rounded to 3 decimals", () => {
  const trims = highlightsToTrims(
    highlights([{ s: 1.23456, e: 2.34567, score: 0.9 }]),
    20,
    { count: 5, minScore: 0.35, pad: 0.111 },
  );
  assert.deepEqual(trims, [{ type: "trim", start: 1.124, end: 2.457 }]);
});

test("an empty highlight report yields no trims", () => {
  assert.deepEqual(
    highlightsToTrims({ candidates: [] }, 20, { count: 5, minScore: 0.35, pad: 0.5 }),
    [],
  );
});

test("candidates fully outside the source are dropped after clamping", () => {
  const trims = highlightsToTrims(
    highlights([
      { s: 21, e: 25, score: 0.9 },
      { s: 19.95, e: 21, score: 0.8 },
    ]),
    20,
    { count: 5, minScore: 0.35, pad: 0.5 },
  );
  assert.deepEqual(trims, [{ type: "trim", start: 19.45, end: 20 }]);
});

const fillers = (is: { s: number; e: number }[]) => ({
  instances: is.map((x) => ({ start: x.s, end: x.e, phrase: "um", context: "… um …" })),
});

test("fillerToCuts expands each instance with asymmetric pads", () => {
  const cuts = fillerToCuts(
    fillers([{ s: 2, e: 2.4 }, { s: 10, e: 10.5 }]),
    30,
    { padBefore: 0.1, padEnd: 0.25 },
  );
  assert.deepEqual(cuts, [
    { type: "cut", start: 1.9, end: 2.65 },
    { type: "cut", start: 9.9, end: 10.75 },
  ]);
});

test("fillerToCuts clamps to source bounds", () => {
  const cuts = fillerToCuts(
    fillers([{ s: 0.05, e: 1 }, { s: 29, e: 30 }]),
    30,
    { padBefore: 0.1, padEnd: 0.25 },
  );
  assert.deepEqual(cuts, [
    { type: "cut", start: 0, end: 1.25 },
    { type: "cut", start: 28.9, end: 30 },
  ]);
});

test("fillerToCuts drops instances fully outside the source", () => {
  assert.deepEqual(
    fillerToCuts(fillers([{ s: 31, e: 32 }]), 30, { padBefore: 0.1, padEnd: 0.25 }),
    [],
  );
});

test("fillerToCuts drops sub-MIN_CUT ranges with zero pads", () => {
  assert.deepEqual(
    fillerToCuts(fillers([{ s: 4, e: 4.005 }]), 30, { padBefore: 0, padEnd: 0 }),
    [],
  );
});

test("fillerToCuts with zero pads cuts the exact estimated ranges", () => {
  assert.deepEqual(
    fillerToCuts(fillers([{ s: 3, e: 4.2 }]), 30, { padBefore: 0, padEnd: 0 }),
    [{ type: "cut", start: 3, end: 4.2 }],
  );
});

test("fillerToCuts rounds timestamps to 3 decimals", () => {
  const cuts = fillerToCuts(fillers([{ s: 1.23456, e: 2.34567 }]), 30, {
    padBefore: 0.111,
    padEnd: 0.222,
  });
  assert.deepEqual(cuts, [{ type: "cut", start: 1.124, end: 2.568 }]);
});

test("an empty filler report yields no cuts", () => {
  assert.deepEqual(
    fillerToCuts({ instances: [] }, 30, { padBefore: 0.1, padEnd: 0.25 }),
    [],
  );
});

test("fillerToCuts is deterministic for identical input", () => {
  const report = fillers([{ s: 1, e: 1.5 }, { s: 5, e: 5.4 }]);
  assert.deepEqual(
    fillerToCuts(report, 30, { padBefore: 0.1, padEnd: 0.25 }),
    fillerToCuts(report, 30, { padBefore: 0.1, padEnd: 0.25 }),
  );
});

const sceneReport = (ts: number[]) => ({
  boundaries: ts.map((t) => ({ timestamp: t, confidence: 0.5 })),
});

test("planReviewGroups spaces per-boundary stills at interval midpoints", () => {
  const { groups, note } = planReviewGroups(sceneReport([10]), 30, { perBoundary: 4, window: 2 });
  assert.equal(note, undefined);
  assert.deepEqual(groups, [{ boundary: 10, times: [9.25, 9.75, 10.25, 10.75] }]);
});

test("per-boundary 1 lands exactly on the boundary", () => {
  const { groups } = planReviewGroups(sceneReport([5.5]), 30, { perBoundary: 1, window: 3 });
  assert.deepEqual(groups, [{ boundary: 5.5, times: [5.5] }]);
});

test("planReviewGroups clamps the window at 0", () => {
  const { groups } = planReviewGroups(sceneReport([0]), 8, { perBoundary: 4, window: 2 });
  assert.deepEqual(groups, [{ boundary: 0, times: [0.125, 0.375, 0.625, 0.875] }]);
});

test("planReviewGroups clamps the window at source duration", () => {
  const atEnd = planReviewGroups(sceneReport([8]), 8, { perBoundary: 4, window: 2 });
  assert.deepEqual(atEnd.groups, [{ boundary: 8, times: [7.125, 7.375, 7.625, 7.875] }]);
  const nearEnd = planReviewGroups(sceneReport([7.8]), 8, { perBoundary: 2, window: 1.6 });
  assert.deepEqual(nearEnd.groups, [{ boundary: 7.8, times: [7.25, 7.75] }]);
});

test("planReviewGroups rounds boundary and times to 3 decimals", () => {
  const { groups } = planReviewGroups(sceneReport([10.0009]), 30, { perBoundary: 4, window: 2 });
  assert.deepEqual(groups, [
    { boundary: 10.001, times: [9.251, 9.751, 10.251, 10.751] },
  ]);
});

test("an empty scenes report yields empty groups with a note, not an error", () => {
  assert.deepEqual(planReviewGroups({ boundaries: [] }, 30, { perBoundary: 4, window: 1.5 }), {
    groups: [],
    note: "no scene boundaries in report",
  });
});

test("boundaries fully outside the source drop; a boundary at duration keeps", () => {
  const { groups, note } = planReviewGroups(sceneReport([31, 30]), 30, { perBoundary: 2, window: 1.5 });
  assert.equal(note, undefined);
  assert.deepEqual(groups, [{ boundary: 30, times: [29.438, 29.813] }]);
  const allOutside = planReviewGroups(sceneReport([31]), 30, { perBoundary: 4, window: 1.5 });
  assert.deepEqual(allOutside, { groups: [], note: "all boundaries outside the source duration" });
});

test("planReviewGroups preserves the report's boundary order", () => {
  const { groups } = planReviewGroups(sceneReport([6, 3]), 9, { perBoundary: 2, window: 1 });
  assert.deepEqual(groups.map((g) => g.boundary), [6, 3]);
});

test("planReviewGroups rejects invalid parameters with OPERATION_INVALID", () => {
  for (const params of [
    { perBoundary: 0, window: 1.5 },
    { perBoundary: 2.5, window: 1.5 },
    { perBoundary: 4, window: 0 },
  ]) {
    assert.throws(
      () => planReviewGroups(sceneReport([10]), 30, params),
      (e: unknown) => (e as { code?: string }).code === "OPERATION_INVALID",
    );
  }
});

// ---- T11: filler precision (exact times from segment.words) ----

const wordSeg = (
  s: number,
  e: number,
  text: string,
  words: { start: number; end: number; text: string }[],
) => ({ start: s, end: e, text, words });

test("filler: word-timed segments anchor exact word times, precision words", () => {
  const t = {
    segments: [
      wordSeg(
        10,
        16,
        "Um, so basically this is filler precision.",
        [
          { start: 10.0, end: 10.4, text: "Um," },
          { start: 10.4, end: 10.6, text: "so" },
          { start: 10.6, end: 11.4, text: "basically," },
          { start: 11.4, end: 11.9, text: "this" },
          { start: 11.9, end: 12.1, text: "is" },
          { start: 12.1, end: 12.7, text: "filler" },
          { start: 12.7, end: 13.3, text: "precision." },
        ],
      ),
    ],
  };
  assert.deepEqual(detectFillerInstances(t), {
    precision: "words",
    instances: [
      { start: 10, end: 10.4, phrase: "um", context: "Um, so basically, this" },
      { start: 10.6, end: 11.4, phrase: "basically", context: "Um, so basically, this is filler" },
    ],
  });
});

test("filler: multi-word phrase anchors first-word start to last-word end", () => {
  // note the 0.5 s gap between "you" and "know," — exact anchoring uses the
  // word times verbatim, never a proportional interpolation over the span
  const t = {
    segments: [
      wordSeg(0, 5, "Well you know it works", [
        { start: 0.0, end: 0.5, text: "Well" },
        { start: 0.5, end: 0.9, text: "you" },
        { start: 1.4, end: 1.8, text: "know," },
        { start: 1.8, end: 2.2, text: "it" },
        { start: 2.2, end: 2.5, text: "works" },
      ]),
    ],
  };
  assert.deepEqual(detectFillerInstances(t), {
    precision: "words",
    instances: [
      { start: 0.5, end: 1.8, phrase: "you know", context: "Well you know, it works" },
    ],
  });
});

test("filler: word-text matching normalizes case, punctuation and leading spaces", () => {
  const t = {
    segments: [
      wordSeg(0, 4, "Um, you know?", [
        { start: 0.1, end: 0.5, text: " Um, " }, // whisper habit: leading space + comma
        { start: 0.6, end: 0.8, text: "You" },
        { start: 0.8, end: 1.2, text: "KNOW?" },
      ]),
    ],
  };
  const { instances } = detectFillerInstances(t);
  assert.deepEqual(
    instances.map((i) => [i.phrase, i.start, i.end]),
    [
      ["um", 0.1, 0.5],
      ["you know", 0.6, 1.2],
    ],
  );
});

test("filler: matched words are consumed and the longest phrase wins (words path)", () => {
  const t = {
    segments: [
      wordSeg(0, 3, "um um you know you know", [
        { start: 0.0, end: 0.3, text: "um" },
        { start: 0.3, end: 0.6, text: "um" },
        { start: 0.6, end: 0.9, text: "you" },
        { start: 0.9, end: 1.2, text: "know" },
        { start: 1.2, end: 1.5, text: "you" },
        { start: 1.5, end: 1.8, text: "know" },
      ]),
    ],
  };
  const { instances } = detectFillerInstances(t);
  assert.deepEqual(
    instances.map((i) => [i.phrase, i.start, i.end]),
    [
      ["um", 0, 0.3],
      ["um", 0.3, 0.6],
      ["you know", 0.6, 1.2],
      ["you know", 1.2, 1.8],
    ],
  );
  // longest phrase wins: "um um" as a custom phrase consumes both words
  const { instances: consumed } = detectFillerInstances(t, ["um", "um um"]);
  assert.deepEqual(
    consumed.map((i) => [i.phrase, i.start, i.end]),
    [["um um", 0, 0.6]],
  );
});

test("filler: phrases never match across segment boundaries (both paths)", () => {
  const withWords = {
    segments: [
      wordSeg(0, 2, "and then you", [
        { start: 0.0, end: 0.5, text: "and" },
        { start: 0.5, end: 1.0, text: "then" },
        { start: 1.0, end: 2.0, text: "you" },
      ]),
      wordSeg(2, 4, "know the rest", [
        { start: 2.0, end: 2.4, text: "know" },
        { start: 2.4, end: 2.6, text: "the" },
        { start: 2.6, end: 4.0, text: "rest." },
      ]),
    ],
  };
  // a cross-boundary matcher would pair "you"(1.0-2.0) with "know"(2.0-2.4)
  const exact = detectFillerInstances(withWords, ["you know"]);
  assert.deepEqual(exact.instances, []);
  assert.equal(exact.precision, "words");
  const wordless = {
    segments: withWords.segments.map(({ words: _w, ...s }) => s),
  };
  assert.deepEqual(detectFillerInstances(wordless, ["you know"]).instances, []);
});

test("filler: precision is words only when EVERY segment carries words", () => {
  const mixed = {
    segments: [
      wordSeg(0, 2, "um here", [
        { start: 0.1, end: 0.4, text: "um" },
        { start: 0.5, end: 1.9, text: "here" },
      ]),
      { start: 2, end: 6, text: "you know later" },
    ],
  };
  const { instances, precision } = detectFillerInstances(mixed);
  assert.equal(precision, "segments"); // one wordless segment drops the report-level claim
  assert.deepEqual(instances[0], { start: 0.1, end: 0.4, phrase: "um", context: "um here" }); // still exact where words exist
  // the wordless segment interpolates: 3 tokens over [2,6] -> [2, 4.667]
  assert.equal(instances[1]!.phrase, "you know");
  assert.ok(Math.abs(instances[1]!.start - 2) < 0.001);
  assert.ok(Math.abs(instances[1]!.end - 4.667) < 0.001);
});

test("filler: an empty words array falls back to interpolation", () => {
  const t = { segments: [{ start: 0, end: 2, text: "um here", words: [] }] };
  const { instances, precision } = detectFillerInstances(t);
  assert.equal(precision, "segments");
  assert.deepEqual(instances.map((i) => [i.start, i.end]), [[0, 1]]);
});

test("filler: wordless transcripts keep the pre-T11 estimate output byte-identical (regression lock)", () => {
  // expected values captured from the pre-T11 detector on the same inputs
  const single = detectFillerInstances({
    segments: [
      {
        start: 10,
        end: 16,
        text: "Um, so basically this is the video toolkit transcription test. You know, it should find these words.",
      },
    ],
  }, DEFAULT_FILLER_PHRASES);
  assert.equal(single.precision, "segments");
  assert.equal(
    JSON.stringify(single.instances),
    JSON.stringify([
      { start: 10, end: 10.353, phrase: "um", context: "Um, so basically this" },
      { start: 10.706, end: 11.059, phrase: "basically", context: "Um, so basically this is the" },
      { start: 13.529, end: 14.235, phrase: "you know", context: "toolkit transcription test. You know, it should find" },
    ]),
  );
  const multi = detectFillerInstances({
    segments: [
      { start: 0, end: 4.5, text: "Well you um like that" },
      { start: 4.5, end: 9, text: "know what I mean, honestly" },
    ],
  }, DEFAULT_FILLER_PHRASES);
  assert.equal(
    JSON.stringify(multi.instances),
    JSON.stringify([
      { start: 1.8, end: 2.7, phrase: "um", context: "Well you um like that" },
      { start: 2.7, end: 3.6, phrase: "like", context: "Well you um like that" },
      { start: 6.3, end: 8.1, phrase: "i mean", context: "know what I mean, honestly" },
      { start: 8.1, end: 9, phrase: "honestly", context: "what I mean, honestly" },
    ]),
  );
});

test("filler: words path is deterministic for identical input", () => {
  const t = {
    segments: [
      wordSeg(0, 5, "you know it works", [
        { start: 0.5, end: 0.9, text: "you" },
        { start: 0.9, end: 1.3, text: "know" },
        { start: 1.3, end: 1.7, text: "it" },
        { start: 1.7, end: 2.1, text: "works" },
      ]),
    ],
  };
  assert.deepEqual(detectFillerInstances(t), detectFillerInstances(t));
});

test("fillerToCuts pads expand from the exact word-anchored times", () => {
  const t = {
    segments: [
      wordSeg(0, 4, "well um done", [
        { start: 0.5, end: 0.8, text: "well" },
        { start: 1.0, end: 1.3, text: "um" },
        { start: 1.5, end: 2.2, text: "done" },
      ]),
    ],
  };
  const { instances, precision } = detectFillerInstances(t);
  assert.equal(precision, "words");
  assert.deepEqual(
    fillerToCuts(
      { instances, params: { phrases: DEFAULT_FILLER_PHRASES, precision } },
      30,
      { padBefore: 0.1, padEnd: 0.25 },
    ),
    [{ type: "cut", start: 0.9, end: 1.55 }],
  );
});
