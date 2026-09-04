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

// ---- crossfade op (T12; kind allowlist frozen from this build's
// `ffmpeg -h filter=xfade` — T13's live catalog must stay a superset)

test("crossfade parses with default kind fade; explicit kinds accepted", () => {
  const p = EditPlan.parse({ ...base, operations: [{ type: "crossfade", duration: 0.5 }] });
  const op = p.operations[0] as { type: string; duration: number; kind: string };
  assert.equal(op.type, "crossfade");
  assert.equal(op.duration, 0.5);
  assert.equal(op.kind, "fade"); // schema default — always present after parse

  const q = EditPlan.parse({
    ...base,
    operations: [{ type: "crossfade", duration: 1, kind: "circleopen" }],
  });
  assert.equal((q.operations[0] as { kind: string }).kind, "circleopen");
});

test("crossfade duration must be positive (and sane-max bounded)", () => {
  assert.equal(
    EditPlan.safeParse({ ...base, operations: [{ type: "crossfade", duration: 0 }] }).success,
    false,
  );
  assert.equal(
    EditPlan.safeParse({ ...base, operations: [{ type: "crossfade", duration: -0.5 }] }).success,
    false,
  );
  assert.equal(
    EditPlan.safeParse({ ...base, operations: [{ type: "crossfade", duration: 61 }] }).success,
    false,
  );
});

test("crossfade kind outside the frozen allowlist rejected", () => {
  // real xfade transitions NOT in the frozen v1 set are rejected too — the
  // allowlist is the contract, not the build's full 58-entry enum
  assert.equal(
    EditPlan.safeParse({ ...base, operations: [{ type: "crossfade", duration: 0.5, kind: "circlecrop" }] }).success,
    false,
  );
  assert.equal(
    EditPlan.safeParse({ ...base, operations: [{ type: "crossfade", duration: 0.5, kind: "zoom" }] }).success,
    false,
  );
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

test("overlay-text parses minimal and full forms", () => {
  const minimal = EditPlan.parse({ ...base, operations: [{ type: "overlay-text", text: "Title" }] });
  assert.equal(minimal.operations[0]?.type, "overlay-text");

  const full = EditPlan.parse({
    ...base,
    operations: [{
      type: "overlay-text",
      text: "It's 100% done",
      from: 0.5,
      to: 4,
      position: "center",
      fontsize: 72,
      color: "0xFFCC0080",
      box: false,
    }],
  });
  assert.equal(full.operations.length, 1);
});

test("overlay-text bounds enforced: text, window, position, fontsize, color shape", () => {
  const bad: unknown[] = [
    { type: "overlay-text" }, // text is required
    { type: "overlay-text", text: "" },
    { type: "overlay-text", text: "x".repeat(1025) },
    { type: "overlay-text", text: "x", from: -1 },
    { type: "overlay-text", text: "x", to: -0.5 },
    { type: "overlay-text", text: "x", position: "middle" },
    { type: "overlay-text", text: "x", fontsize: 0 },
    { type: "overlay-text", text: "x", fontsize: 513 },
    { type: "overlay-text", text: "x", fontsize: 48.5 }, // non-integer
    { type: "overlay-text", text: "x", color: "white;" }, // filter syntax
    { type: "overlay-text", text: "x", color: "red,blue" },
    { type: "overlay-text", text: "x", color: "0x12345" }, // 5 hex digits
    { type: "overlay-text", text: "x", color: "#ffffff" }, // # form not accepted
  ];
  for (const op of bad) {
    assert.equal(
      EditPlan.safeParse({ ...base, operations: [op] }).success,
      false,
      `expected schema rejection: ${JSON.stringify(op)}`,
    );
  }
  // 0xRRGGBB and 0xRRGGBBAA hex and plain names are fine
  for (const color of ["white", "LightBlue", "0xFFFFFF", "0xffcc0080", "gray42"]) {
    assert.equal(
      EditPlan.safeParse({ ...base, operations: [{ type: "overlay-text", text: "x", color }] }).success,
      true,
      `expected color accepted: ${color}`,
    );
  }
});

test("audio-mix parses minimal and full forms", () => {
  const minimal = EditPlan.parse({ ...base, operations: [{ type: "audio-mix", file: "bed.mp3" }] });
  assert.equal(minimal.operations[0]?.type, "audio-mix");

  const full = EditPlan.parse({
    ...base,
    operations: [
      {
        type: "audio-mix",
        file: "bed.mp3",
        level: -18,
        duck: { threshold: 0.02, ratio: 8, attack: 20, release: 400, makeup: 2 },
      },
    ],
  });
  assert.equal(full.operations.length, 1);
});

test("audio-mix bounds enforced: level dB, LINEAR threshold, duck ranges", () => {
  const bad: unknown[] = [
    { type: "audio-mix", file: "bed.mp3", level: 1 }, // > 0 dB
    { type: "audio-mix", file: "bed.mp3", level: -61 },
    { type: "audio-mix" }, // file is required
    { type: "audio-mix", file: "bed.mp3", duck: { threshold: 0.00001 } }, // below 2^-10
    { type: "audio-mix", file: "bed.mp3", duck: { threshold: 1.5 } },
    { type: "audio-mix", file: "bed.mp3", duck: { ratio: 0.5 } },
    { type: "audio-mix", file: "bed.mp3", duck: { ratio: 21 } },
    { type: "audio-mix", file: "bed.mp3", duck: { attack: 0.001 } },
    { type: "audio-mix", file: "bed.mp3", duck: { attack: 2001 } },
    { type: "audio-mix", file: "bed.mp3", duck: { release: 0.001 } },
    { type: "audio-mix", file: "bed.mp3", duck: { release: 9001 } },
    { type: "audio-mix", file: "bed.mp3", duck: { makeup: 0.5 } },
    { type: "audio-mix", file: "bed.mp3", duck: { makeup: 65 } },
  ];
  for (const op of bad) {
    assert.equal(
      EditPlan.safeParse({ ...base, operations: [op] }).success,
      false,
      `expected schema rejection: ${JSON.stringify(op)}`,
    );
  }
});
