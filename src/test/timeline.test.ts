import { test } from "node:test";
import assert from "node:assert/strict";
import { adjustedDuration, compileTimeline, totalDuration, xfadeOffsets } from "../core/timeline.js";
import type { Operation } from "../core/schemas.js";

const dur = 100;

function segs(ops: Operation[]) {
  return compileTimeline(ops, dur);
}

test("no operations keeps the whole source", () => {
  assert.deepEqual(segs([]), [{ start: 0, end: 100 }]);
});

test("single trim keeps its range", () => {
  assert.deepEqual(segs([{ type: "trim", start: 10, end: 20 }]), [{ start: 10, end: 20 }]);
});

test("multiple trims union, sort, and merge touching ranges", () => {
  assert.deepEqual(
    segs([
      { type: "trim", start: 50, end: 60 },
      { type: "trim", start: 10, end: 20 },
      { type: "trim", start: 20, end: 30 },
    ]),
    [
      { start: 10, end: 30 },
      { start: 50, end: 60 },
    ],
  );
});

test("cut splits a kept segment", () => {
  assert.deepEqual(
    segs([
      { type: "trim", start: 0, end: 30 },
      { type: "cut", start: 10, end: 15 },
    ]),
    [
      { start: 0, end: 10 },
      { start: 15, end: 30 },
    ],
  );
});

test("cut spanning across two trims removes from both", () => {
  assert.deepEqual(
    segs([
      { type: "trim", start: 0, end: 10 },
      { type: "trim", start: 20, end: 30 },
      { type: "cut", start: 5, end: 25 },
    ]),
    [
      { start: 0, end: 5 },
      { start: 25, end: 30 },
    ],
  );
});

test("operation order does not matter", () => {
  const a = segs([
    { type: "cut", start: 5, end: 25 },
    { type: "trim", start: 0, end: 30 },
  ]);
  const b = segs([
    { type: "trim", start: 0, end: 30 },
    { type: "cut", start: 5, end: 25 },
  ]);
  assert.deepEqual(a, b);
});

test("cutting everything fails with EMPTY_TIMELINE", () => {
  assert.throws(
    () => segs([{ type: "cut", start: 0, end: 100 }]),
    /remove every part/,
  );
});

test("tiny residual segments are dropped", () => {
  const result = segs([
    { type: "trim", start: 0, end: 30 },
    { type: "cut", start: 29.995, end: 30 },
  ]);
  assert.deepEqual(result, [{ start: 0, end: 29.995 }]);
});

test("totalDuration sums segments", () => {
  const t = segs([
    { type: "trim", start: 0, end: 10 },
    { type: "trim", start: 20, end: 30 },
  ]);
  assert.equal(totalDuration(t), 20);
});

// ---- crossfade math (T12; law + offsets per R3's measured record:
// docs/ultron/research/r3-xfade-single-pass.md)

// R3's exact fixture timeline: keep [1,4]+[5.5,9]+[11,14.5], D=0.5
const R3 = [
  { start: 1, end: 4 },
  { start: 5.5, end: 9 },
  { start: 11, end: 14.5 },
];

test("xfadeOffsets: O_k = Σ L_i (i≤k) − k·D — R3's measured case", () => {
  assert.deepEqual(xfadeOffsets(R3, 0.5), [2.5, 5.5]);
});

test("xfadeOffsets: N=2 and odd lengths (R3 F1/F3)", () => {
  assert.deepEqual(xfadeOffsets([{ start: 0, end: 3 }, { start: 5, end: 8.5 }], 0.5), [2.5]);
  // lengths 1.733/3.336, D=0.4 -> O1 = 1.733 − 0.4 = 1.333
  const odd = xfadeOffsets([{ start: 0, end: 1.733 }, { start: 5, end: 8.336 }], 0.4);
  assert.equal(odd.length, 1);
  assert.ok(Math.abs(odd[0]! - 1.333) < 1e-9, `offset ${odd[0]}`);
});

test("xfadeOffsets: N segments produce N−1 offsets; single segment none", () => {
  assert.deepEqual(xfadeOffsets([{ start: 0, end: 10 }], 0.5), []);
  const five = [1, 2, 3, 4, 5].map((s) => ({ start: s, end: s + 1 }));
  // lengths all 1, D=0.25 -> offsets [0.75, 1.5, 2.25, 3.0]
  assert.deepEqual(xfadeOffsets(five, 0.25), [0.75, 1.5, 2.25, 3.0]);
});

test("adjustedDuration: output = timeline − (N−1)·D (the one canonical law)", () => {
  assert.equal(adjustedDuration(R3, 0.5), 9.0); // R3 outB: measured 9.000 / 270f
  assert.equal(adjustedDuration([{ start: 0, end: 3 }, { start: 5, end: 8.5 }], 0.5), 6.0); // F1
  // 5 segments, D=0.25 -> 5 − 4·0.25 = 4.0
  const five = [1, 2, 3, 4, 5].map((s) => ({ start: s, end: s + 1 }));
  assert.equal(adjustedDuration(five, 0.25), 4.0);
});

test("adjustedDuration: D=0 or single segment degrade to the plain total", () => {
  assert.equal(adjustedDuration(R3, 0), 10.0);
  assert.equal(adjustedDuration([{ start: 0, end: 7 }], 0.5), 7.0);
});

test("adjustedDuration: shrinkage never goes negative (clamped)", () => {
  // a pathological (validate-rejected) D larger than the timeline cannot
  // produce a negative expectation
  assert.equal(adjustedDuration(R3, 100), 0);
});
