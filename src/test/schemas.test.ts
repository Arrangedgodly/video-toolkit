import { test } from "node:test";
import assert from "node:assert/strict";
import { CROSSFADE_KINDS, EditPlan } from "../core/schemas.js";
import { parseXfadeTransitions } from "../media/transitions.js";
import { XFADE_HELP_FIXTURE } from "./xfade-help-fixture.js";

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

// ---- crossfade op (T12 landed the op; T17 widened the kind allowlist to the
// FULL verified catalog — equality with `ffmpeg -h filter=xfade` is enforced
// below against the committed fixture; `custom` parses only to be fenced)

test("crossfade allowlist EQUALS the committed fixture's catalog parse (T17, both directions)", () => {
  // deepEqual is bidirectional: no allowlisted kind missing from the catalog,
  // no catalog kind missing from the allowlist — and the ORDER (help listing)
  // is pinned too, so drift in either direction fails loudly
  assert.deepEqual([...CROSSFADE_KINDS], parseXfadeTransitions(XFADE_HELP_FIXTURE));
  assert.equal(CROSSFADE_KINDS.length, 58);
  // the `custom` sentinel is not a kind: excluded from the allowlist AND from
  // the catalog parse (enum value −1, needs expr=)
  assert.equal(CROSSFADE_KINDS.includes("custom" as (typeof CROSSFADE_KINDS)[number]), false);
});

test("crossfade parses with default kind fade; explicit kinds accepted", () => {
  const p = EditPlan.parse({ ...base, operations: [{ type: "crossfade", duration: 0.5 }] });
  const op = p.operations[0] as { type: string; duration: number; kind: string };
  assert.equal(op.type, "crossfade");
  assert.equal(op.duration, 0.5);
  assert.equal(op.kind, "fade"); // schema default — always present after parse

  // T12 kinds stay accepted…
  const q = EditPlan.parse({
    ...base,
    operations: [{ type: "crossfade", duration: 1, kind: "circleopen" }],
  });
  assert.equal((q.operations[0] as { kind: string }).kind, "circleopen");

  // …and so do T17's newly unlocked ones (first/middle/last + the quirk
  // suspects from the plan: hlslice, the radial/distance family)
  for (const kind of ["circlecrop", "distance", "smoothup", "pixelize", "hlslice", "revealdown"]) {
    const r = EditPlan.parse({ ...base, operations: [{ type: "crossfade", duration: 0.5, kind }] });
    assert.equal((r.operations[0] as { kind: string }).kind, kind, kind);
  }
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

test("crossfade kind outside the verified allowlist rejected; `custom` parses (fenced at validate)", () => {
  // not a catalog kind at all — the allowlist remains the contract
  assert.equal(
    EditPlan.safeParse({ ...base, operations: [{ type: "crossfade", duration: 0.5, kind: "zoom" }] }).success,
    false,
  );
  assert.equal(
    EditPlan.safeParse({ ...base, operations: [{ type: "crossfade", duration: 0.5, kind: "fader" }] }).success,
    false,
  );
  // `custom` IS parseable — the xfade expr= sentinel routes to validate's
  // OPERATION_INVALID fence (tested in ops-integration) instead of a generic
  // enum rejection
  assert.equal(
    EditPlan.safeParse({ ...base, operations: [{ type: "crossfade", duration: 0.5, kind: "custom" }] }).success,
    true,
  );
});

test("unknown operation type rejected", () => {
  assert.equal(
    EditPlan.safeParse({ ...base, operations: [{ type: "spin", start: 0, end: 1 }] }).success,
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

// ---- zoom (T18; Ken Burns transform op per R5's committed parameter table,
// docs/ultron/research/r5-zoom-motion.md — factor ranges are VALIDATE fences
// (OPERATION_INVALID), so the schema keeps the value raw)

test("zoom parses minimal (all keys optional) and full forms; mode/easing defaults applied", () => {
  const minimal = EditPlan.parse({ ...base, operations: [{ type: "zoom" }] });
  const op = minimal.operations[0] as { type: string; mode: string; factor?: number; easing: string };
  assert.equal(op.type, "zoom");
  assert.equal(op.mode, "in"); // schema default — always present after parse
  assert.equal(op.easing, "smooth");
  assert.equal(op.factor, undefined); // render layer defaults it to 1.2

  const full = EditPlan.parse({
    ...base,
    operations: [{ type: "zoom", mode: "left", factor: 1.35, easing: "linear" }],
  });
  const f = full.operations[0] as { mode: string; factor: number; easing: string };
  assert.equal(f.mode, "left");
  assert.equal(f.factor, 1.35);
  assert.equal(f.easing, "linear");
});

test("zoom mode/easing enums enforced; factor stays raw for validate's fence", () => {
  for (const op of [
    { type: "zoom", mode: "diagonal" },
    { type: "zoom", easing: "ease-in-out" },
    { type: "zoom", factor: "1.5" }, // not a number
  ]) {
    assert.equal(
      EditPlan.safeParse({ ...base, operations: [op] }).success,
      false,
      `expected schema rejection: ${JSON.stringify(op)}`,
    );
  }
  // the factor RANGE is deliberately NOT schema-bounded: 1.0 and 2.5 parse
  // so validate can reject them with its own OPERATION_INVALID naming the
  // range (R5's constraints table — tested in ops-integration)
  for (const factor of [1, 0.5, 2.5, 7]) {
    assert.equal(
      EditPlan.safeParse({ ...base, operations: [{ type: "zoom", factor }] }).success,
      true,
      `factor ${factor} must parse (validate fences the range)`,
    );
  }
});

// ---- image-overlay (T21; ONE image burned over the composed output in the
// same pass — png-with-alpha contract, overlay-text visibility-window
// semantics, opacity deliberately RAW like zoom.factor so validate fences it)

test("image-overlay parses minimal and full forms", () => {
  const minimal = EditPlan.parse({ ...base, operations: [{ type: "image-overlay", file: "logo.png" }] });
  assert.equal(minimal.operations[0]?.type, "image-overlay");

  const full = EditPlan.parse({
    ...base,
    operations: [{
      type: "image-overlay",
      file: "wm.png",
      position: "top-left",
      width: 320,
      opacity: 0.8,
      from: 0.5,
      to: 4,
    }],
  });
  assert.equal(full.operations.length, 1);
});

test("image-overlay bounds enforced: file, position enum, integer width, window ≥ 0; opacity stays raw for validate's fence", () => {
  const bad: unknown[] = [
    { type: "image-overlay" }, // file is required
    { type: "image-overlay", file: "" },
    { type: "image-overlay", file: "x.png", position: "middle" },
    { type: "image-overlay", file: "x.png", position: "bottom" }, // overlay-text position, not this op's enum
    { type: "image-overlay", file: "x.png", width: 0 },
    { type: "image-overlay", file: "x.png", width: 16385 },
    { type: "image-overlay", file: "x.png", width: 480.5 }, // non-integer
    { type: "image-overlay", file: "x.png", from: -1 },
    { type: "image-overlay", file: "x.png", to: -0.5 },
  ];
  for (const op of bad) {
    assert.equal(
      EditPlan.safeParse({ ...base, operations: [op] }).success,
      false,
      `expected schema rejection: ${JSON.stringify(op)}`,
    );
  }
  // the opacity RANGE is deliberately NOT schema-bounded (the zoom.factor
  // pattern): 0 / negative / >1 parse so validate can reject them with its
  // own OPERATION_INVALID naming the range (tested in ops-integration)
  for (const opacity of [0, -0.5, 1.5, 7]) {
    assert.equal(
      EditPlan.safeParse({ ...base, operations: [{ type: "image-overlay", file: "x.png", opacity }] }).success,
      true,
      `opacity ${opacity} must parse (validate fences the range)`,
    );
  }
  // boundary widths accepted (the resize/export-gif mirror: int 1..16384)
  for (const width of [1, 16384]) {
    assert.equal(
      EditPlan.safeParse({ ...base, operations: [{ type: "image-overlay", file: "x.png", width }] }).success,
      true,
      `width ${width} must parse`,
    );
  }
});

// ---- export-gif (T19; terminal export op — first of the export-op class,
// NOT a TransformOpType member: it changes the output FORMAT, not content)

test("export-gif parses minimal (all keys optional) and full forms", () => {
  const minimal = EditPlan.parse({
    ...base,
    output: { path: "out.gif" },
    operations: [{ type: "export-gif" }],
  });
  assert.equal(minimal.operations[0]?.type, "export-gif");

  const full = EditPlan.parse({
    ...base,
    output: { path: "out.gif" },
    operations: [{ type: "export-gif", width: 640, fps: 15, from: 0.5, to: 4 }],
  });
  assert.equal(full.operations.length, 1);
});

test("export-gif bounds enforced: integer width (resize mirror), fps ≤ 60, window ≥ 0", () => {
  const bad: unknown[] = [
    { type: "export-gif", width: 0 },
    { type: "export-gif", width: 16385 },
    { type: "export-gif", width: 480.5 }, // non-integer
    { type: "export-gif", fps: 0 },
    { type: "export-gif", fps: -1 },
    { type: "export-gif", fps: 60.5 },
    { type: "export-gif", from: -0.5 },
    { type: "export-gif", to: -1 },
  ];
  for (const op of bad) {
    assert.equal(
      EditPlan.safeParse({ ...base, output: { path: "out.gif" }, operations: [op] }).success,
      false,
      `expected schema rejection: ${JSON.stringify(op)}`,
    );
  }
  // boundary values are accepted: width 1..16384, fps exactly 60, window at 0
  for (const op of [
    { type: "export-gif", width: 1 },
    { type: "export-gif", width: 16384 },
    { type: "export-gif", fps: 60 },
    { type: "export-gif", from: 0, to: 0.5 },
  ]) {
    assert.equal(
      EditPlan.safeParse({ ...base, output: { path: "out.gif" }, operations: [op] }).success,
      true,
      `expected acceptance: ${JSON.stringify(op)}`,
    );
  }
});
