import { test } from "node:test";
import assert from "node:assert/strict";
import { EditPlan } from "../core/schemas.js";
import { atempoChain, buildRenderCommand, escapeDrawText, escapeFilterPath, type MixOptions } from "../media/ffmpeg.js";

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

// ---- overlay-text (drawtext; escaping empirically verified against this
// ffmpeg build: pixel-identical renders vs a textfile= ground truth)

const overlay = {
  text: "Hello World",
  position: "bottom" as "top" | "center" | "bottom",
  fontsize: 48,
  color: "white",
  box: true,
};

test("escapeDrawText: drawtext's own two-pass escaping rule", () => {
  // drawtext text crosses TWO unescaping stages (filtergraph tokenizer +
  // option-value tokenizer): `\`->4 backslashes, `'`->3, `:`->2, `,;[]`->1
  assert.equal(escapeDrawText("Hello World"), "Hello World");
  assert.equal(escapeDrawText("a:b"), "a\\\\:b");
  assert.equal(escapeDrawText("a,b"), "a\\,b");
  assert.equal(escapeDrawText("it's"), "it\\\\\\'s");
  // `C:\path` -> C, 2BS+":" (colon rule), 4BS (backslash rule), path
  assert.equal(escapeDrawText("C:\\path"), "C" + "\\\\" + ":" + "\\\\\\\\" + "path");
  assert.equal(escapeDrawText("100% sure"), "100% sure"); // literal under expansion=none
  assert.equal(escapeDrawText("semi;colon"), "semi\\;colon");
  assert.equal(escapeDrawText("brack[et]"), "brack\\[et\\]");
  assert.equal(
    escapeDrawText("Rate: 50%, it's #1; top [v2]"),
    "Rate\\\\: 50%\\, it\\\\\\'s #1\\; top \\[v2\\]",
  );
});

test("builder: overlay-text drawtext composes after scale/subtitles, before format", () => {
  const argv = buildRenderCommand("in.mp4", segs, "out.mp4", {
    ...opts,
    scaleWidth: 640,
    subtitleFile: "subs.srt",
    overlayText: { ...overlay, text: "Hello: it's 100% done" },
  }, true);
  const vf = argv[argv.indexOf("-vf") + 1]!;
  const iScale = vf.indexOf("scale=640:-2");
  const iSubs = vf.indexOf("subtitles=");
  const iDraw = vf.indexOf("drawtext=");
  const iFmt = vf.indexOf("format=yuv420p");
  assert.ok(iScale !== -1 && iSubs !== -1 && iDraw !== -1 && iFmt !== -1, vf);
  assert.ok(iScale < iDraw && iSubs < iDraw && iDraw < iFmt, `drawtext must sit between scale/subtitles and format: ${vf}`);
  // defaults + the fixed font + the escaped text + expansion=none
  assert.ok(vf.includes("fontfile=/System/Library/Fonts/Helvetica.ttc"), vf);
  assert.ok(vf.includes("text=Hello\\\\: it\\\\\\'s 100% done"), vf);
  assert.ok(vf.includes("fontsize=48"), vf);
  assert.ok(vf.includes("fontcolor=white"), vf);
  assert.ok(vf.includes("box=1:boxcolor=black@0.5:boxborderw=12"), vf);
  assert.ok(vf.includes("expansion=none"), vf);
  assert.ok(!vf.includes("enable="), "no window given -> always visible, no enable");
});

test("builder: overlay-text enable window math incl. omitted bounds (3-decimal times)", () => {
  const both = buildRenderCommand("in.mp4", segs, "out.mp4", {
    ...opts, overlayText: { ...overlay, from: 0.5, to: 2 },
  }, true);
  const fromOnly = buildRenderCommand("in.mp4", segs, "out.mp4", {
    ...opts, overlayText: { ...overlay, from: 1 },
  }, true);
  const toOnly = buildRenderCommand("in.mp4", segs, "out.mp4", {
    ...opts, overlayText: { ...overlay, to: 3.4567 },
  }, true);
  assert.ok(both[both.indexOf("-vf") + 1]!.includes("enable='between(t,0.500,2.000)'"));
  assert.ok(fromOnly[fromOnly.indexOf("-vf") + 1]!.includes("enable='gte(t,1.000)'"));
  assert.ok(toOnly[toOnly.indexOf("-vf") + 1]!.includes("enable='lte(t,3.457)'"));
});

test("builder: overlay-text positions map to y expressions; box off; custom fontsize/color", () => {
  const yFor = (o: Partial<typeof overlay>) => {
    const argv = buildRenderCommand("in.mp4", segs, "out.mp4", { ...opts, overlayText: { ...overlay, ...o } }, true);
    const vf = argv[argv.indexOf("-vf") + 1]!;
    return /y=([^:]+):/.exec(vf)?.[1] ?? "";
  };
  assert.equal(yFor({ position: "top" }), "h*0.1");
  assert.equal(yFor({ position: "center" }), "(h-text_h)/2");
  assert.equal(yFor({ position: "bottom" }), "h-text_h-h*0.1");

  const argv = buildRenderCommand("in.mp4", segs, "out.mp4", {
    ...opts,
    overlayText: { ...overlay, position: "center", fontsize: 96, color: "0xFFCC00", box: false },
  }, true);
  const vf = argv[argv.indexOf("-vf") + 1]!;
  assert.ok(vf.includes("fontsize=96"), vf);
  assert.ok(vf.includes("fontcolor=0xFFCC00"), vf);
  assert.ok(!vf.includes("box="), vf);
  assert.ok(vf.includes("x=(w-text_w)/2"), vf);
});

// ---- crossfade (transition chain template: docs/ultron/research/
// r3-xfade-single-pass.md — N -ss/-t inputs + chained xfade/acrossfade,
// speed/scale/subtitles/overlay AFTER the chain, ONE invocation)

test("builder: crossfade N=2 emits the validated transition graph verbatim", () => {
  const argv = buildRenderCommand(
    "in.mp4",
    [{ start: 0, end: 3 }, { start: 5, end: 8.5 }],
    "out.mp4",
    { ...opts, crossfade: { duration: 0.5, kind: "fade" } },
    true,
  );
  assert.deepEqual(argv, [
    "-nostdin", "-hide_banner", "-y",
    "-ss", "0.000", "-t", "3.000", "-i", "in.mp4",
    "-ss", "5.000", "-t", "3.500", "-i", "in.mp4",
    "-filter_complex",
    "[0:v][1:v]xfade=transition=fade:duration=0.500:offset=2.500,format=yuv420p[v];" +
      "[0:a][1:a]acrossfade=d=0.500[a]",
    "-map", "[v]", "-map", "[a]",
    "-c:a", "aac", "-b:a", "192k",
    "-c:v", "libx264", "-crf", "18", "-preset", "medium",
    "-movflags", "+faststart", "out.mp4",
  ]);
  // no select/-vf/-af anywhere — this is the alternative composition
  assert.equal(argv.includes("-vf"), false);
  assert.equal(argv.includes("-af"), false);
  assert.equal(argv.includes("select="), false);
});

test("builder: crossfade N=3 (R3's exact fixture) — offsets, kind, tails", () => {
  const argv = buildRenderCommand(
    "in.mp4",
    [{ start: 1, end: 4 }, { start: 5.5, end: 9 }, { start: 11, end: 14.5 }],
    "out.mp4",
    {
      ...opts,
      speedFactor: 2,
      normalizeLufs: -16,
      volumeDb: -6,
      scaleWidth: 640,
      subtitleFile: "subs.srt",
      subtitleStyle: "FontSize=24",
      crossfade: { duration: 0.5, kind: "wiperight" },
    },
    true,
  );
  // three inputs of the SAME source, exact -ss/-t windows
  const inputs: string[][] = [];
  for (let i = argv.indexOf("-i"); i !== -1; i = argv.indexOf("-i", i + 1)) {
    inputs.push(argv.slice(i - 4, i + 2));
  }
  assert.deepEqual(inputs, [
    ["-ss", "1.000", "-t", "3.000", "-i", "in.mp4"],
    ["-ss", "5.500", "-t", "3.500", "-i", "in.mp4"],
    ["-ss", "11.000", "-t", "3.500", "-i", "in.mp4"],
  ]);

  const graph = argv[argv.indexOf("-filter_complex") + 1]!;
  assert.equal(
    graph,
    // offsets O1=2.5, O2=5.5 (R3 outB); the LAST xfade carries the video
    // tail: setpts (PTS/s — NOT N/FRAME_RATE/TB) → scale → subtitles → format
    "[0:v][1:v]xfade=transition=wiperight:duration=0.500:offset=2.500[v1];" +
      "[v1][2:v]xfade=transition=wiperight:duration=0.500:offset=5.500," +
      "setpts=PTS/2,scale=640:-2,subtitles=filename=" + escapeFilterPath("subs.srt") +
      ":force_style='FontSize=24',format=yuv420p[v];" +
      // audio: chained acrossfade (d=D per join), tail on the last link
      "[0:a][1:a]acrossfade=d=0.500[a1];" +
      "[a1][2:a]acrossfade=d=0.500,atempo=2,loudnorm=I=-16:TP=-1.5:LRA=11,volume=-6dB[a]",
    graph,
  );
  assert.deepEqual(
    argv.slice(argv.indexOf("-map"), argv.indexOf("-map") + 4),
    ["-map", "[v]", "-map", "[a]"],
  );
});

test("builder: crossfade on an audio-less source is video-only (-an, no acrossfade)", () => {
  const argv = buildRenderCommand(
    "in.mp4",
    [{ start: 0, end: 3 }, { start: 5, end: 8.5 }],
    "out.mp4",
    { ...opts, crossfade: { duration: 0.5, kind: "fade" } },
    false,
  );
  const graph = argv[argv.indexOf("-filter_complex") + 1]!;
  assert.equal(graph, "[0:v][1:v]xfade=transition=fade:duration=0.500:offset=2.500,format=yuv420p[v]");
  assert.equal(argv.includes("acrossfade"), false);
  assert.equal(argv.includes("[a]"), false);
  assert.deepEqual(
    argv.slice(argv.indexOf("-map"), argv.indexOf("-map") + 2),
    ["-map", "[v]"],
  );
  assert.ok(argv.includes("-an"), argv.join(" "));
});

test("builder: crossfade + overlay-text composes after the chain (drawtext)", () => {
  const argv = buildRenderCommand(
    "in.mp4",
    [{ start: 0, end: 3 }, { start: 5, end: 8.5 }],
    "out.mp4",
    { ...opts, overlayText: overlay, crossfade: { duration: 0.5, kind: "fade" } },
    true,
  );
  const graph = argv[argv.indexOf("-filter_complex") + 1]!;
  const iDraw = graph.indexOf("drawtext=");
  const iFmt = graph.indexOf("format=yuv420p");
  assert.ok(iDraw !== -1 && iDraw < iFmt, graph);
  assert.ok(graph.includes("text=Hello World"), graph);
});

test("builder: crossfade refuses the unvalidated audio-mix composition", () => {
  assert.throws(
    () =>
      buildRenderCommand(
        "in.mp4",
        [{ start: 0, end: 3 }, { start: 5, end: 8.5 }],
        "out.mp4",
        { ...opts, mix, crossfade: { duration: 0.5, kind: "fade" } },
        true,
      ),
    (e: unknown) => (e as { code?: string }).code === "OPERATION_INVALID",
  );
});

test("builder: crossfade with <2 segments is refused (validate's rule, never a silent no-op)", () => {
  assert.throws(
    () =>
      buildRenderCommand(
        "in.mp4",
        [{ start: 0, end: 3 }],
        "out.mp4",
        { ...opts, crossfade: { duration: 0.5, kind: "fade" } },
        true,
      ),
    (e: unknown) => (e as { code?: string }).code === "OPERATION_INVALID",
  );
});

test("builder: without crossfade the select path is unchanged (no -filter_complex)", () => {
  const argv = buildRenderCommand(
    "in.mp4",
    [{ start: 0, end: 3 }, { start: 5, end: 8.5 }],
    "out.mp4",
    opts,
    true,
  );
  assert.equal(argv.filter((a) => a === "-i").length, 1);
  assert.equal(argv.includes("-filter_complex"), false);
  assert.ok(argv[argv.indexOf("-vf") + 1]!.startsWith("select='between(t,0.000,3.000)+"), argv.join(" "));
  assert.notEqual(argv.indexOf("-af"), -1);
});
