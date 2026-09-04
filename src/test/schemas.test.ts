import { test } from "node:test";
import assert from "node:assert/strict";
import { EditPlan } from "../core/schemas.js";

const base = {
  version: 1,
  source: "input.mp4",
  output: { path: "output.mp4" },
};

test("minimal plan validates; operations and mode default", () => {
  const p = EditPlan.parse(base);
  assert.deepEqual(p.operations, []);
  assert.equal(p.output.mode, "final");
});

test("trim/cut/normalize-audio all accepted", () => {
  const p = EditPlan.parse({
    ...base,
    operations: [
      { type: "trim", start: 3.2, end: 120.5 },
      { type: "cut", start: 24.1, end: 27.8 },
      { type: "normalize-audio" },
      { type: "normalize-audio", target: -14 },
    ],
  });
  assert.equal(p.operations.length, 4);
  assert.equal(p.operations[3]?.type, "normalize-audio");
});

test("unsupported version rejected", () => {
  assert.equal(EditPlan.safeParse({ ...base, version: 2 }).success, false);
});

test("unknown operation type rejected", () => {
  assert.equal(
    EditPlan.safeParse({ ...base, operations: [{ type: "zoom", start: 0, end: 1 }] }).success,
    false,
  );
});

test("negative timestamps rejected by schema", () => {
  assert.equal(
    EditPlan.safeParse({ ...base, operations: [{ type: "trim", start: -1, end: 5 }] }).success,
    false,
  );
});

test("missing end rejected", () => {
  assert.equal(
    EditPlan.safeParse({ ...base, operations: [{ type: "trim", start: 0 }] }).success,
    false,
  );
});

test("normalize-audio target bounds enforced", () => {
  assert.equal(
    EditPlan.safeParse({ ...base, operations: [{ type: "normalize-audio", target: 3 }] }).success,
    false,
  );
});
