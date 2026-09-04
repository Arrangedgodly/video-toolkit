import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSilenceOutput } from "../analysis/silence.js";
import { parseSceneOutput } from "../analysis/scenes.js";
import { silenceToCuts } from "../analysis/silence-to-cuts.js";

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
