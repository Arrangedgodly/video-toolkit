import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCapture } from "../media/ffprobe.js";
import { validatePlan } from "../validate/validate.js";
import { ToolError } from "../core/errors.js";
import {
  LINT_CODES,
  lintOperations,
  lintPlanFile,
  mergeableTrims,
  noopCuts,
  noopVolume,
  overlappingCuts,
  redundantCuts,
  redundantTrims,
  subsecondSegments,
} from "../validate/lint.js";
import type { Operation } from "../core/schemas.js";

// T24: the seven rules are PURE functions over plan JSON + the source
// duration — the rule units below run on constructed ops (DUR = 100, no
// media). The file-level wrapper tests at the bottom use a real 10 s fixture
// because lintPlanFile rides validatePlan (source stat + metadata probe).

const DUR = 100;

const codes = (suggestions: { code: string; operation?: number }[]) =>
  suggestions.map((s) => [s.code, s.operation]);

// ---- REDUNDANT_TRIM

test("REDUNDANT_TRIM fires: a trim fully contained in an earlier trim", () => {
  const ops: Operation[] = [
    { type: "trim", start: 0, end: 20 },
    { type: "trim", start: 5, end: 10 },
  ];
  const out = redundantTrims(ops);
  assert.deepEqual(codes(out), [["REDUNDANT_TRIM", 2]]);
  assert.ok(out[0]!.message.includes("operation 1"), out[0]!.message);
  assert.equal(out[0]!.fix, "remove operation 2");
});

test("REDUNDANT_TRIM fires: contained in the UNION of earlier trims", () => {
  // [0,10] ∪ [5,15] = [0,15] ⊇ [2,12] — no single earlier trim covers it
  const ops: Operation[] = [
    { type: "trim", start: 0, end: 10 },
    { type: "trim", start: 5, end: 15 },
    { type: "trim", start: 2, end: 12 },
  ];
  assert.deepEqual(codes(redundantTrims(ops)), [["REDUNDANT_TRIM", 3]]);
});

test("REDUNDANT_TRIM containment follows the compiler's own merge semantics", () => {
  // earlier trims [0,10] + [10.0005,20] epsilon-merge to [0,20] — a later
  // [5,15] contributes nothing even though plain range subtraction would
  // leave a 0.0005 sliver (sub-MIN_SEGMENT residuals are dropped)
  const ops: Operation[] = [
    { type: "trim", start: 0, end: 10 },
    { type: "trim", start: 10.0005, end: 20 },
    { type: "trim", start: 5, end: 15 },
  ];
  assert.deepEqual(codes(redundantTrims(ops)), [["REDUNDANT_TRIM", 3]]);
});

test("REDUNDANT_TRIM negative: disjoint, extending, or lone trims are fine", () => {
  assert.deepEqual(redundantTrims([{ type: "trim", start: 0, end: 10 }]), []);
  assert.deepEqual(
    redundantTrims([
      { type: "trim", start: 0, end: 10 },
      { type: "trim", start: 20, end: 30 },
    ]),
    [],
  );
  // extends beyond the earlier trim — real new kept time
  assert.deepEqual(
    redundantTrims([
      { type: "trim", start: 0, end: 10 },
      { type: "trim", start: 5, end: 15 },
    ]),
    [],
  );
});

// ---- REDUNDANT_CUT

test("REDUNDANT_CUT fires: duplicate cut — only the second is flagged", () => {
  const ops: Operation[] = [
    { type: "cut", start: 3, end: 6 },
    { type: "cut", start: 3, end: 6 },
  ];
  const out = redundantCuts(ops, DUR);
  assert.deepEqual(codes(out), [["REDUNDANT_CUT", 2]]);
  assert.ok(out[0]!.message.includes("operation 1"), out[0]!.message);
  assert.equal(out[0]!.fix, "remove operation 2");
});

test("REDUNDANT_CUT fires: a cut outside the kept trims removes nothing", () => {
  const ops: Operation[] = [
    { type: "trim", start: 0, end: 10 },
    { type: "cut", start: 50, end: 60 },
  ];
  const out = redundantCuts(ops, DUR);
  assert.deepEqual(codes(out), [["REDUNDANT_CUT", 2]]);
  assert.ok(out[0]!.message.includes("never kept"), out[0]!.message);
});

test("REDUNDANT_CUT negative: first cut, disjoint cuts, and partial overlaps do work", () => {
  assert.deepEqual(redundantCuts([{ type: "cut", start: 3, end: 6 }], DUR), []);
  assert.deepEqual(
    redundantCuts([
      { type: "cut", start: 3, end: 6 },
      { type: "cut", start: 7, end: 9 },
    ], DUR),
    [],
  );
  // [5,8] still removes [6,8] — real work (OVERLAPPING_CUTS' concern, not this rule)
  assert.deepEqual(
    redundantCuts([
      { type: "cut", start: 3, end: 6 },
      { type: "cut", start: 5, end: 8 },
    ], DUR),
    [],
  );
});

// ---- MERGEABLE_TRIMS

test("MERGEABLE_TRIMS fires: a 0.005 s gap names the pair, anchored on the later op", () => {
  const ops: Operation[] = [
    { type: "trim", start: 0, end: 10 },
    { type: "trim", start: 10.005, end: 20 },
  ];
  const out = mergeableTrims(ops);
  assert.deepEqual(codes(out), [["MERGEABLE_TRIMS", 2]]);
  assert.ok(out[0]!.message.includes("operation 1") && out[0]!.message.includes("operation 2"));
  assert.ok(out[0]!.message.includes("0.005s gap"), out[0]!.message);
  assert.equal(out[0]!.fix, "replace operations 1 and 2 with one trim [0.000, 20.000]");
});

test("MERGEABLE_TRIMS fires at gap 0 (touching) and inside the compiler's silent band", () => {
  assert.deepEqual(
    codes(mergeableTrims([
      { type: "trim", start: 0, end: 10 },
      { type: "trim", start: 10, end: 20 },
    ])),
    [["MERGEABLE_TRIMS", 2]],
  );
  // gap 0.0005 < TOUCH_EPSILON: the compiler already merged them silently —
  // the rule still names the pair for plan hygiene
  assert.deepEqual(
    codes(mergeableTrims([
      { type: "trim", start: 0, end: 10 },
      { type: "trim", start: 10.0005, end: 20 },
    ])),
    [["MERGEABLE_TRIMS", 2]],
  );
});

test("MERGEABLE_TRIMS negative: wider gaps and overlapping trims are not this rule", () => {
  assert.deepEqual(
    mergeableTrims([
      { type: "trim", start: 0, end: 10 },
      { type: "trim", start: 10.02, end: 20 },
    ]),
    [],
  );
  // overlapping trims already union — not a gap
  assert.deepEqual(
    mergeableTrims([
      { type: "trim", start: 0, end: 10 },
      { type: "trim", start: 5, end: 15 },
    ]),
    [],
  );
  assert.deepEqual(mergeableTrims([{ type: "trim", start: 0, end: 10 }]), []);
});

// ---- NOOP_VOLUME

test("NOOP_VOLUME fires on db 0 and factor 1", () => {
  assert.deepEqual(codes(noopVolume([{ type: "volume", db: 0 }])), [["NOOP_VOLUME", 1]]);
  assert.deepEqual(codes(noopVolume([{ type: "volume", factor: 1 }])), [["NOOP_VOLUME", 1]]);
  assert.ok(noopVolume([{ type: "volume", db: 0 }])[0]!.fix!.includes("remove operation 1"));
});

test("NOOP_VOLUME negative: real gains stay silent", () => {
  assert.deepEqual(noopVolume([{ type: "volume", db: -3 }]), []);
  assert.deepEqual(noopVolume([{ type: "volume", factor: 1.5 }]), []);
});

// ---- NOOP_CUT

test("NOOP_CUT fires: a cut removing < 0.010 s of kept time is a degenerate sliver", () => {
  const out = noopCuts([{ type: "cut", start: 10, end: 10.005 }], DUR);
  assert.deepEqual(codes(out), [["NOOP_CUT", 1]]);
  assert.ok(out[0]!.message.includes("0.005s of kept time"), out[0]!.message);
  assert.ok(out[0]!.fix!.includes("remove operation 1"));
});

test("NOOP_CUT fires: start/end equal at 3 decimals", () => {
  const out = noopCuts([{ type: "cut", start: 10, end: 10.0004 }], DUR);
  assert.deepEqual(codes(out), [["NOOP_CUT", 1]]);
  assert.ok(out[0]!.message.includes("same 3-decimal timestamp"), out[0]!.message);
});

test("NOOP_CUT negative: a cut with real kept-time effect is left alone", () => {
  assert.deepEqual(noopCuts([{ type: "cut", start: 10, end: 12 }], DUR), []);
  assert.deepEqual(noopCuts([{ type: "cut", start: 10, end: 10.02 }], DUR), []);
});

// ---- OVERLAPPING_CUTS

test("OVERLAPPING_CUTS fires pairwise: the LATER declared cut is flagged", () => {
  const ops: Operation[] = [
    { type: "cut", start: 3, end: 6 },
    { type: "cut", start: 5, end: 8 },
  ];
  const out = overlappingCuts(ops);
  assert.deepEqual(codes(out), [["OVERLAPPING_CUTS", 2]]);
  assert.ok(out[0]!.message.includes("operation 1"), out[0]!.message);
  assert.ok(out[0]!.message.includes("1.000s"), out[0]!.message);
});

test("OVERLAPPING_CUTS negative: disjoint or touching cuts never intersect", () => {
  assert.deepEqual(
    overlappingCuts([
      { type: "cut", start: 3, end: 6 },
      { type: "cut", start: 6, end: 8 }, // touching at 6 — zero-length intersection
      { type: "cut", start: 20, end: 25 },
    ]),
    [],
  );
  assert.deepEqual(overlappingCuts([{ type: "cut", start: 3, end: 6 }]), []);
});

// ---- SUBSECOND_SEGMENT

test("SUBSECOND_SEGMENT fires: a compiled keep-segment < 0.5 s, bounds at 3 decimals", () => {
  const ops: Operation[] = [
    { type: "trim", start: 0, end: 5 },
    { type: "trim", start: 6, end: 6.3 },
    { type: "cut", start: 2, end: 3 },
  ];
  const out = subsecondSegments(ops, DUR);
  assert.deepEqual(codes(out), [["SUBSECOND_SEGMENT", undefined]]);
  assert.ok(out[0]!.message.includes("[6.000, 6.300]"), out[0]!.message);
  assert.ok(out[0]!.message.includes("0.300s"), out[0]!.message);
  assert.equal(out[0]!.operation, undefined); // compiled, not declared — no op anchor
});

test("SUBSECOND_SEGMENT negative: every compiled segment >= 0.5 s", () => {
  assert.deepEqual(
    subsecondSegments([
      { type: "trim", start: 0, end: 5 },
      { type: "cut", start: 1, end: 2 },
    ], DUR),
    [],
  );
  assert.deepEqual(subsecondSegments([], DUR), []); // whole source, one long segment
});

// ---- assembler: ordering, determinism, clean plans

test("lintOperations orders by operation index, then code — stable across runs", () => {
  const ops: Operation[] = [
    { type: "trim", start: 0, end: 20 },        // 1
    { type: "trim", start: 5, end: 10 },        // 2 REDUNDANT_TRIM
    { type: "trim", start: 20.005, end: 30 },   // 3 MERGEABLE_TRIMS (pair with op 1)
    { type: "cut", start: 12, end: 13 },        // 4 (real work)
    { type: "cut", start: 12, end: 13 },        // 5 REDUNDANT_CUT + OVERLAPPING_CUTS(op 4)
    { type: "volume", db: 0 },                  // 6 NOOP_VOLUME
  ];
  const out = lintOperations(ops, DUR);
  assert.deepEqual(codes(out), [
    ["REDUNDANT_TRIM", 2],
    ["MERGEABLE_TRIMS", 3],
    ["OVERLAPPING_CUTS", 5],
    ["REDUNDANT_CUT", 5],
    ["NOOP_VOLUME", 6],
  ]);
  // determinism: same plan -> byte-identical output
  assert.equal(JSON.stringify(lintOperations(ops, DUR)), JSON.stringify(out));
});

test("lintOperations: compiled-segment suggestions (no operation anchor) sort last", () => {
  const ops: Operation[] = [
    { type: "trim", start: 0, end: 10 },
    { type: "trim", start: 1, end: 2 }, // REDUNDANT_TRIM, op 2
    { type: "trim", start: 20, end: 20.3 }, // compiles to a 0.3 s keep-segment
    { type: "cut", start: 3, end: 3.004 }, // NOOP_CUT, op 4 (0.004 s of kept time)
  ];
  const out = lintOperations(ops, DUR);
  assert.deepEqual(codes(out), [
    ["REDUNDANT_TRIM", 2],
    ["NOOP_CUT", 4],
    ["SUBSECOND_SEGMENT", undefined],
  ]);
});

test("lintOperations: a clean plan yields an empty report", () => {
  assert.deepEqual(lintOperations([], DUR), []);
  assert.deepEqual(
    lintOperations([
      { type: "trim", start: 0, end: 50 },
      { type: "cut", start: 10, end: 20 },
      { type: "volume", db: -3 },
    ], DUR),
    [],
  );
});

test("LINT_CODES is exactly the seven rules (SUGGEST_PREVIEW omitted by record)", () => {
  assert.deepEqual([...LINT_CODES], [
    "MERGEABLE_TRIMS",
    "NOOP_CUT",
    "NOOP_VOLUME",
    "OVERLAPPING_CUTS",
    "REDUNDANT_CUT",
    "REDUNDANT_TRIM",
    "SUBSECOND_SEGMENT",
  ]);
});

// ---- file-level wrapper (real media: lintPlanFile rides validatePlan)

const FIXTURE = "lint-fixture.mp4"; // 10 s testsrc2 + sine
let dir = "";

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "video-toolkit-lint-"));
  process.chdir(dir);
  const r = await runCapture("ffmpeg", [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30",
    "-f", "lavfi", "-i", "sine=frequency=440",
    "-t", "10", "-c:v", "libx264", "-crf", "28", "-pix_fmt", "yuv420p",
    "-c:a", "aac", FIXTURE,
  ]);
  assert.equal(r.code, 0, r.stderr);
});

after(async () => {
  process.chdir(tmpdir());
  await rm(dir, { recursive: true, force: true });
});

test("lintPlanFile: valid plan -> suggestions; lint NEVER changes validate's verdict", async () => {
  const plan = {
    version: 1,
    source: FIXTURE,
    operations: [
      { type: "trim", start: 0, end: 4 },
      { type: "trim", start: 1, end: 3 }, // redundant
      { type: "volume", db: 0 }, // identity
    ],
    output: { path: "lint-out.mp4" },
  };
  await writeFile("clean-verdict.json", JSON.stringify(plan));
  const r = await lintPlanFile("clean-verdict.json");
  assert.equal(r.valid, true);
  if (!r.valid) return;
  assert.deepEqual(codes(r.suggestions), [["REDUNDANT_TRIM", 2], ["NOOP_VOLUME", 3]]);
  // file path and pure engine agree on the same ops
  assert.equal(
    JSON.stringify(r.suggestions),
    JSON.stringify(lintOperations(plan.operations as Operation[], 10)),
  );
  // the verdict-unchanged assertion: the same suggestion-laden plan is STILL
  // valid — advisory means advisory
  const v = await validatePlan("clean-verdict.json");
  assert.equal(v.valid, true, JSON.stringify(v.errors));
});

test("lintPlanFile: an INVALID plan returns the existing validate contract", async () => {
  await writeFile("lint-invalid.json", JSON.stringify({
    version: 1,
    source: FIXTURE,
    operations: [{ type: "trim", start: 0, end: 999 }],
    output: { path: "lint-invalid-out.mp4" },
  }));
  const r = await lintPlanFile("lint-invalid.json");
  assert.equal(r.valid, false);
  if (r.valid) return;
  assert.equal(r.validation.valid, false);
  assert.ok(r.validation.errors.length > 0);
  assert.equal(r.validation.errors[0]!.code, "TIMESTAMP_OUT_OF_RANGE"); // existing codes only
});

test("lintPlanFile: a missing plan file fails with the existing SOURCE_NOT_FOUND", async () => {
  await assert.rejects(
    () => lintPlanFile("does-not-exist.json"),
    (e: unknown) => e instanceof ToolError && e.code === "SOURCE_NOT_FOUND",
  );
});
