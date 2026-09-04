import { test } from "node:test";
import assert from "node:assert/strict";
import { EditPlan } from "../core/schemas.js";
import { atempoChain, buildRenderCommand } from "../media/ffmpeg.js";

const base = {
  version: 1,
  source: "input.mp4",
  output: { path: "output.mp4" },
};

const opts = {
  encoder: "libx264" as const,
  crf: 18,
  preset: "medium",
  videoBitrate: "10M",
  audioBitrate: "192k",
  normalizeLufs: null,
};

const segs = [{ start: 0, end: 10 }];

test("speed/resize/volume operations parse", () => {
  const p = EditPlan.parse({
    ...base,
    operations: [
      { type: "speed", factor: 1.25 },
      { type: "resize", width: 1280 },
      { type: "resize", width: 1280, height: 720 },
      { type: "volume", db: -6 },
      { type: "volume", factor: 1.5 },
    ],
  });
  assert.equal(p.operations.length, 5);
});

test("speed factor bounds enforced by schema", () => {
  assert.equal(EditPlan.safeParse({ ...base, operations: [{ type: "speed", factor: 0 }] }).success, false);
  assert.equal(EditPlan.safeParse({ ...base, operations: [{ type: "speed", factor: 11 }] }).success, false);
});

test("resize requires positive integer width", () => {
  assert.equal(EditPlan.safeParse({ ...base, operations: [{ type: "resize", width: 0 }] }).success, false);
  assert.equal(EditPlan.safeParse({ ...base, operations: [{ type: "resize", width: 640.5 }] }).success, false);
});

test("atempoChain handles any factor via clamped instances", () => {
  assert.equal(atempoChain(1.5), "atempo=1.5");
  assert.equal(atempoChain(2), "atempo=2");
  assert.equal(atempoChain(4), "atempo=2,atempo=2");
  assert.equal(atempoChain(0.25), "atempo=0.5,atempo=0.5");
  assert.equal(atempoChain(0.3), "atempo=0.5,atempo=0.6");
});

test("builder: speed divides timestamps and chains atempo", () => {
  const argv = buildRenderCommand("in.mp4", segs, "out.mp4", { ...opts, speedFactor: 2 }, true);
  const vf = argv[argv.indexOf("-vf") + 1]!;
  const af = argv[argv.indexOf("-af") + 1]!;
  assert.ok(vf.includes("setpts=N/FRAME_RATE/TB/2"), vf);
  assert.ok(af.includes("atempo=2"), af);
});

test("builder: volume db and factor (converted) apply after loudnorm", () => {
  const argv = buildRenderCommand("in.mp4", segs, "out.mp4", { ...opts, volumeDb: -6 }, true);
  const af = argv[argv.indexOf("-af") + 1]!;
  assert.ok(af.includes("volume=-6dB"), af);

  const argv2 = buildRenderCommand("in.mp4", segs, "out.mp4", { ...opts, volumeDb: 20 * Math.log10(2) }, true);
  assert.ok(argv2[argv2.indexOf("-af") + 1]!.includes("volume=6.0206dB"));

  const argv3 = buildRenderCommand(
    "in.mp4", segs, "out.mp4",
    { ...opts, volumeDb: -6, normalizeLufs: -16 },
    true,
  );
  const af3 = argv3[argv3.indexOf("-af") + 1]!;
  assert.ok(af3.indexOf("loudnorm") < af3.indexOf("volume="), af3);
});

test("builder: resize width-only keeps aspect; explicit height is exact", () => {
  const argv = buildRenderCommand("in.mp4", segs, "out.mp4", { ...opts, scaleWidth: 640 }, true);
  assert.ok(argv[argv.indexOf("-vf") + 1]!.includes("scale=640:-2"));

  const argv2 = buildRenderCommand(
    "in.mp4", segs, "out.mp4",
    { ...opts, scaleWidth: 640, scaleHeight: 360 },
    true,
  );
  assert.ok(argv2[argv2.indexOf("-vf") + 1]!.includes("scale=640:360"));
});

test("builder: no audio stream drops -af entirely", () => {
  const argv = buildRenderCommand("in.mp4", segs, "out.mp4", { ...opts, volumeDb: -6 }, false);
  assert.equal(argv.includes("-af"), false);
  assert.ok(argv.includes("-an"));
});
