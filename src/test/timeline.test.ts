import { test } from "node:test";
import assert from "node:assert/strict";
import { compileTimeline, totalDuration } from "../core/timeline.js";
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
