import { test } from "node:test";
import assert from "node:assert/strict";
import { EditPlan } from "../core/schemas.js";
import { atempoChain, buildRenderCommand, type MixOptions } from "../media/ffmpeg.js";

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

// ---- audio-mix (graph template: docs/ultron/research/r1-audio-mix-single-pass.md)

const mix: MixOptions = {
  bedFile: "bed.mp3",
  levelDb: -18,
  duck: { threshold: 0.02, ratio: 8, attack: 20, release: 400 },
  bedTrimSeconds: 10,
  speechSampleRate: 44100,
  speechLayout: "stereo",
};

test("builder: audio-mix emits the validated single-pass sidechain graph verbatim", () => {
  const argv = buildRenderCommand("in.mp4", segs, "out.mp4", { ...opts, mix }, true);

  // two inputs: source, then the looped bed (-stream_loop is a per-input
  // option and must precede the bed -i)
  const firstInput = argv.indexOf("-i");
  assert.deepEqual(
    argv.slice(firstInput + 2, firstInput + 6),
    ["-stream_loop", "-1", "-i", "bed.mp3"],
    argv.join(" "),
  );

  // audio moves into -filter_complex; -af is gone
  assert.equal(argv.includes("-af"), false);
  const graph = argv[argv.indexOf("-filter_complex") + 1]!;
  assert.equal(
    graph,
    "[0:a]aselect='between(t,0.000,10.000)',asetpts=N/SR/TB,aformat=channel_layouts=stereo[speech];" +
      "[speech]asplit=2[sc][main];" +
      "[1:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo," +
      "volume=-18dB,asetpts=N/SR/TB,atrim=duration=10[bed];" +
      "[bed][sc]sidechaincompress=threshold=0.02:ratio=8:attack=20:release=400[ducked];" +
      "[main][ducked]amix=inputs=2:duration=first:normalize=0[a]",
    graph,
  );

  // natural termination: no -shortest, no -t
  assert.equal(argv.includes("-shortest"), false);
  assert.equal(argv.includes("-t"), false);

  // explicit maps: video straight from 0:v, audio from the complex graph
  const mapIdx = argv.indexOf("-map");
  assert.deepEqual(argv.slice(mapIdx, mapIdx + 4), ["-map", "0:v", "-map", "[a]"]);

  // the video -vf chain is untouched by the mix
  const vf = argv[argv.indexOf("-vf") + 1]!;
  assert.ok(vf.startsWith("select='between(t,0.000,10.000)'"), vf);
  assert.ok(vf.endsWith("format=yuv420p"), vf);
});

test("builder: speed/loudnorm/volume compose around the mix in filter order", () => {
  const argv = buildRenderCommand(
    "in.mp4", segs, "out.mp4",
    { ...opts, mix, speedFactor: 2, normalizeLufs: -16, volumeDb: -6 },
    true,
  );
  const graph = argv[argv.indexOf("-filter_complex") + 1]!;
  // atempo rides the speech chain before the split
  assert.ok(graph.includes("asetpts=N/SR/TB,atempo=2,aformat=channel_layouts=stereo[speech]"), graph);
  // global transforms act on the final program, AFTER the mix
  assert.ok(
    graph.endsWith("amix=inputs=2:duration=first:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11,volume=-6dB[a]"),
    graph,
  );
  // video keeps its own speed handling
  assert.ok(argv[argv.indexOf("-vf") + 1]!.includes("setpts=N/FRAME_RATE/TB/2"));
});

test("builder: level and duck params map 1:1 to sidechaincompress (makeup optional)", () => {
  const argv = buildRenderCommand("in.mp4", segs, "out.mp4", {
    ...opts,
    mix: {
      ...mix,
      levelDb: -12,
      duck: { threshold: 0.03, ratio: 12, attack: 5, release: 900, makeup: 1.5 },
    },
  }, true);
  const graph = argv[argv.indexOf("-filter_complex") + 1]!;
  assert.ok(graph.includes("volume=-12dB"), graph);
  assert.ok(
    graph.includes("sidechaincompress=threshold=0.03:ratio=12:attack=5:release=900:makeup=1.5"),
    graph,
  );
});

test("builder: threshold keeps full precision (linear minimum survives)", () => {
  const argv = buildRenderCommand("in.mp4", segs, "out.mp4", {
    ...opts,
    mix: { ...mix, duck: { threshold: 0.000976563, ratio: 8, attack: 20, release: 400 } },
  }, true);
  const graph = argv[argv.indexOf("-filter_complex") + 1]!;
  assert.ok(graph.includes("threshold=0.000976563"), graph);
});

test("builder: without a mix the legacy -af path is unchanged", () => {
  const argv = buildRenderCommand("in.mp4", segs, "out.mp4", { ...opts, mix: null }, true);
  assert.equal(argv.includes("-filter_complex"), false);
  assert.equal(argv.includes("-map"), false);
  assert.equal(argv.filter((a) => a === "-i").length, 1);
  assert.notEqual(argv.indexOf("-af"), -1);
});

test("builder: mix on an audio-less source is a no-op (no bed input, no graph)", () => {
  const argv = buildRenderCommand("in.mp4", segs, "out.mp4", { ...opts, mix }, false);
  assert.equal(argv.includes("-filter_complex"), false);
  assert.equal(argv.includes("-stream_loop"), false);
  assert.equal(argv.filter((a) => a === "-i").length, 1);
  assert.ok(argv.includes("-an"));
});
