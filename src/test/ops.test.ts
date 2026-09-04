import { test } from "node:test";
import assert from "node:assert/strict";
import { EditPlan } from "../core/schemas.js";
import {
  atempoChain,
  buildRenderCommand,
  escapeDrawText,
  escapeFilterPath,
  overlayPositionExpressions,
  zoomExpressions,
  zoomPanFilter,
  zoomRampFrames,
  type ImageOverlayOptions,
  type MixOptions,
  type ZoomOptions,
} from "../media/ffmpeg.js";

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

// ---- export-gif (single-pass palette graph; recipe proven verbatim in
// vedit's build_gif, vedit.py:363-375 — palettegen+paletteuse INSIDE the one
// -filter_complex, never a separate palette pass)

test("builder: export-gif emits vedit's palette graph verbatim after the select chain", () => {
  const argv = buildRenderCommand("in.mp4", segs, "out.gif", {
    ...opts,
    gif: { width: 480, fps: 12 },
  }, true);
  assert.deepEqual(argv, [
    "-nostdin", "-hide_banner", "-y",
    "-i", "in.mp4",
    "-filter_complex",
    "[0:v]select='between(t,0.000,10.000)',setpts=N/FRAME_RATE/TB," +
      "fps=12,scale=480:-2:flags=lanczos,split[a][b];" +
      "[a]palettegen=stats_mode=diff[p];" +
      "[b][p]paletteuse=dither=bayer:bayer_scale=5[v]",
    "-map", "[v]",
    "-an",
    "out.gif",
  ]);
  // the gif branch: no h264/movflags/audio anywhere
  assert.equal(argv.includes("-c:v"), false);
  assert.equal(argv.includes("-movflags"), false);
  assert.equal(argv.includes("-af"), false);
  assert.equal(argv.includes("-c:a"), false);
});

test("builder: export-gif window math incl. omitted bounds (trim before fps, 3-decimal times)", () => {
  const both = buildRenderCommand("in.mp4", segs, "out.gif", {
    ...opts, gif: { width: 480, fps: 12, from: 0.5, to: 3 },
  }, true);
  const fromOnly = buildRenderCommand("in.mp4", segs, "out.gif", {
    ...opts, gif: { width: 480, fps: 12, from: 1 },
  }, true);
  const toOnly = buildRenderCommand("in.mp4", segs, "out.gif", {
    ...opts, gif: { width: 480, fps: 12, to: 3.4567 },
  }, true);
  const g = (argv: string[]) => argv[argv.indexOf("-filter_complex") + 1]!;
  assert.ok(g(both).includes("trim=start=0.500:end=3.000,setpts=PTS-STARTPTS,fps=12"), g(both));
  assert.ok(g(fromOnly).includes("trim=start=1.000,setpts=PTS-STARTPTS,fps=12"), g(fromOnly));
  assert.ok(g(toOnly).includes("trim=end=3.457,setpts=PTS-STARTPTS,fps=12"), g(toOnly));
  // no window -> no trim at all (vedit's shape: nothing between setpts and fps)
  assert.ok(g(buildRenderCommand("in.mp4", segs, "out.gif", {
    ...opts, gif: { width: 480, fps: 12 },
  }, true)).includes("setpts=N/FRAME_RATE/TB,fps=12"), "no trim when both bounds omitted");
  // custom width/fps map 1:1
  assert.ok(g(both).includes("fps=12,scale=480:-2:flags=lanczos"));
  const wide = buildRenderCommand("in.mp4", segs, "out.gif", {
    ...opts, gif: { width: 640, fps: 15 },
  }, true);
  assert.ok(g(wide).includes("fps=15,scale=640:-2:flags=lanczos"), g(wide));
});

test("builder: export-gif composes after speed/scale/subtitles/overlay; no yuv420p", () => {
  const argv = buildRenderCommand("in.mp4", segs, "out.gif", {
    ...opts,
    speedFactor: 2,
    scaleWidth: 640,
    subtitleFile: "subs.srt",
    overlayText: overlay,
    gif: { width: 480, fps: 12 },
  }, true);
  const graph = argv[argv.indexOf("-filter_complex") + 1]!;
  const order = ["setpts=N/FRAME_RATE/TB/2", "scale=640:-2", "subtitles=", "drawtext=", "fps=12"];
  let prev = -1;
  for (const part of order) {
    const at = graph.indexOf(part);
    assert.ok(at !== -1, `${part} missing: ${graph}`);
    assert.ok(at > prev, `${part} must come after the previous stage: ${graph}`);
    prev = at;
  }
  assert.equal(graph.includes("format=yuv420p"), false, graph); // palette path owns pixfmt
});

test("builder: export-gif rides the transition chain after the last xfade link", () => {
  const argv = buildRenderCommand(
    "in.mp4",
    [{ start: 0, end: 3 }, { start: 5, end: 8.5 }],
    "out.gif",
    { ...opts, crossfade: { duration: 0.5, kind: "fade" }, gif: { width: 480, fps: 12, from: 0.5, to: 2 } },
    true, // hasAudio — irrelevant under gif: no acrossfade, -an
  );
  assert.deepEqual(argv, [
    "-nostdin", "-hide_banner", "-y",
    "-ss", "0.000", "-t", "3.000", "-i", "in.mp4",
    "-ss", "5.000", "-t", "3.500", "-i", "in.mp4",
    "-filter_complex",
    "[0:v][1:v]xfade=transition=fade:duration=0.500:offset=2.500[vx];" +
      "[vx]trim=start=0.500:end=2.000,setpts=PTS-STARTPTS," +
      "fps=12,scale=480:-2:flags=lanczos,split[a][b];" +
      "[a]palettegen=stats_mode=diff[p];" +
      "[b][p]paletteuse=dither=bayer:bayer_scale=5[v]",
    "-map", "[v]",
    "-an",
    "out.gif",
  ]);
  assert.equal(argv.join(" ").includes("acrossfade"), false);
  assert.equal(argv.includes("-c:v"), false);
});

test("builder: export-gif refusals — non-.gif output and the audio-mix combo", () => {
  assert.throws(
    () => buildRenderCommand("in.mp4", segs, "out.mp4", { ...opts, gif: { width: 480, fps: 12 } }, true),
    (e: unknown) => (e as { code?: string }).code === "OUTPUT_PATH_INVALID",
  );
  assert.throws(
    () => buildRenderCommand("in.mp4", segs, "out.gif", { ...opts, gif: { width: 480, fps: 12 }, mix }, true),
    (e: unknown) => (e as { code?: string }).code === "OPERATION_INVALID",
  );
});

// ---- zoom (Ken Burns single-pass motion; graph + expressions validated in
// docs/ultron/research/r5-zoom-motion.md — R5's binding table transcribed
// into zoomExpressions/zoomPanFilter; both render paths compose it INSIDE
// the one invocation)

const zx = (mode: ZoomOptions["mode"], easing: ZoomOptions["easing"] = "smooth", factor = 1.5): ZoomOptions => ({
  mode, easing, factor, srcFps: 30, srcWidth: 1280, srcHeight: 720,
});

test("zoomExpressions: R5's binding table verbatim (all six modes, both easings)", () => {
  // the record's exact validated parameters: zoom-in, F=1.5, N=210 — the
  // z ramp 1+0.5*min(on/209,1) equals the validated min(1+0.5*on/209,1.5)
  // term-for-term (the clamp pushed inside the affine)
  assert.deepEqual(zoomExpressions("in", 1.5, "linear", 210), {
    z: "1+0.5*min(on/209,1)",
    x: "iw/2-(iw/zoom/2)",
    y: "ih/2-(ih/zoom/2)",
  });
  // smooth easing = smoothstep 3p²−2p³ over the clamped progress
  assert.equal(zoomExpressions("in", 1.5, "smooth", 210).z, "1+0.5*min(on/209,1)*min(on/209,1)*(3-2*min(on/209,1))");
  // zoom-out reverses the ramp: 1+(F-1)*(1-e(p)) — F=1.3 formats as 0.3
  // despite 1.3-1 being 0.30000000000000004 in float (trimNum's 4 decimals)
  assert.equal(zoomExpressions("out", 1.3, "linear", 90).z, "1+0.3*(1-min(on/89,1))");
  // pans: CONSTANT zoom at F, full-range traverse on one axis, centered on
  // the other; camera direction (right = content drifts left)
  assert.deepEqual(zoomExpressions("right", 1.2, "linear", 180), {
    z: "1.2",
    x: "(iw-iw/zoom)*min(on/179,1)",
    y: "ih/2-(ih/zoom/2)",
  });
  assert.deepEqual(zoomExpressions("left", 1.2, "linear", 180), {
    z: "1.2",
    x: "(iw-iw/zoom)*(1-min(on/179,1))",
    y: "ih/2-(ih/zoom/2)",
  });
  assert.deepEqual(zoomExpressions("down", 1.2, "smooth", 180), {
    z: "1.2",
    x: "iw/2-(iw/zoom/2)",
    y: "(ih-ih/zoom)*min(on/179,1)*min(on/179,1)*(3-2*min(on/179,1))",
  });
  assert.deepEqual(zoomExpressions("up", 1.2, "linear", 180), {
    z: "1.2",
    x: "iw/2-(iw/zoom/2)",
    y: "(ih-ih/zoom)*(1-min(on/179,1))",
  });
});

test("zoomExpressions: ABSOLUTE on-frame expressions only — the classic incremental recipes are fenced out", () => {
  // R5 D1a/D1b (measured): `zoom+step` is a SILENT NO-OP with d=1 on this
  // build and `pzoom+step` runs away — a regression to either would make
  // every zoom plan render no motion while staying green on duration
  for (const mode of ["in", "out", "left", "right", "up", "down"] as const) {
    for (const easing of ["smooth", "linear"] as const) {
      const { z, x, y } = zoomExpressions(mode, 1.5, easing, 210);
      for (const expr of [z, x, y]) {
        assert.ok(!expr.includes("zoom+"), `${mode}/${easing}: incremental zoom+ is a measured no-op: ${expr}`);
        assert.ok(!expr.includes("pzoom"), `${mode}/${easing}: pzoom compounds uncontrollably: ${expr}`);
      }
      assert.ok(z.startsWith("1+") || /^[0-9.]+$/.test(z), `${mode}/${easing}: z must be absolute: ${z}`);
      assert.ok(z.includes("on/") || /^[0-9.]+$/.test(z), `${mode}/${easing}: ramps parameterize the output frame counter: ${z}`);
    }
  }
});

test("zoomRampFrames: N = max(2, round(dur×fps)) — whole timeline (select) / per segment (chain)", () => {
  assert.equal(zoomRampFrames(7.0, 30), 210); // R5's select-path instance
  assert.equal(zoomRampFrames(3.0, 30), 90); // R5's F2 segment 1
  assert.equal(zoomRampFrames(4.0, 30), 120); // R5's F2 segment 2
  assert.equal(zoomRampFrames(0.02, 30), 2); // sub-2-frame unit floors (validate rejects it first)
  assert.equal(zoomRampFrames(6.006, 30000 / 1001), 180); // rational fps passes through numerically
});

test("zoomPanFilter: d=1 + probed fps + explicit s= always; ×2 prescale for PAN modes only", () => {
  // zoom modes: NO prescale — the discipline string verbatim
  assert.equal(
    zoomPanFilter(zx("in", "linear"), 210),
    "zoompan=z='1+0.5*min(on/209,1)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:fps=30:s=1280x720",
  );
  assert.equal(
    zoomPanFilter(zx("out", "linear"), 210),
    "zoompan=z='1+0.5*(1-min(on/209,1))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:fps=30:s=1280x720",
  );
  // pan modes: scale=2W:2H rides BEFORE zoompan (native-res pans judder —
  // half the frames frozen on the integer crop origin; E5's mitigation)
  assert.equal(
    zoomPanFilter(zx("right", "linear", 1.2), 210),
    "scale=2560:1440,zoompan=z='1.2':x='(iw-iw/zoom)*min(on/209,1)':y='ih/2-(ih/zoom/2)':d=1:fps=30:s=1280x720",
  );
  // the three defaults this build silently substitutes — d=90 (×108
  // duration), fps=25 (silent re-time), s=hd720 (silent resize) — are never
  // reachable: d=1, the probed fps, and the source WxH are hardwired
  const pan = zoomPanFilter(zx("down", "smooth", 1.2), 210);
  assert.ok(pan.includes(":d=1:fps=30:s=1280x720"), pan);
});

test("builder: select-path zoom sits between select and the retime setpts (R5 C4/C5)", () => {
  const argv = buildRenderCommand("in.mp4", [{ start: 1, end: 4 }, { start: 5.5, end: 9.5 }], "out.mp4", {
    ...opts, zoom: zx("in", "linear", 1.5),
  }, true);
  const vf = argv[argv.indexOf("-vf") + 1]!;
  const iSelect = vf.indexOf("select=");
  const iZoom = vf.indexOf("zoompan=");
  const iSetpts = vf.indexOf("setpts=");
  assert.ok(iSelect !== -1 && iZoom !== -1 && iSetpts !== -1, vf);
  assert.ok(iSelect < iZoom && iZoom < iSetpts, `zoompan must sit between select and setpts: ${vf}`);
  // one continuous 210-frame ramp over the WHOLE 7.0s timeline (union of
  // both segments — zoompan runs before the speed retime, so N is unscaled)
  assert.ok(vf.includes("zoompan=z='1+0.5*min(on/209,1)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:fps=30:s=1280x720"), vf);
  // still ONE invocation with the plain -vf path (no complex graph)
  assert.equal(argv.includes("-filter_complex"), false);
  assert.equal(argv.filter((a) => a === "-i").length, 1);
});

test("builder: zoom + speed composes with speed AFTER zoompan (zoompan discards input PTS)", () => {
  const argv = buildRenderCommand("in.mp4", [{ start: 0, end: 7 }], "out.mp4", {
    ...opts, zoom: zx("in", "linear", 1.5), speedFactor: 1.25,
  }, true);
  const vf = argv[argv.indexOf("-vf") + 1]!;
  assert.ok(vf.indexOf("zoompan=") < vf.indexOf("setpts=N/FRAME_RATE/TB/1.25"), vf);
  // audio is untouched by zoompan — the ordinary aselect/atempo chain rides -af
  assert.ok(argv[argv.indexOf("-af") + 1]!.includes("atempo=1.25"));
  assert.ok(!argv.join(" ").includes("azoompan"));
});

test("builder: transition chain zoompans EVERY input uniformly before the xfade links (R5 F2/F2b)", () => {
  // R5's exact F2 instance parameters: N=2, F=1.3 per segment, D=0.5 —
  // per-input ramps N_1=90 (3.0s) and N_2=120 (4.0s)
  const argv = buildRenderCommand(
    "in.mp4",
    [{ start: 1, end: 4 }, { start: 5.5, end: 9.5 }],
    "out.mp4",
    { ...opts, zoom: zx("in", "linear", 1.3), crossfade: { duration: 0.5, kind: "fade" } },
    true,
  );
  const graph = argv[argv.indexOf("-filter_complex") + 1]!;
  assert.equal(
    graph,
    "[0:v]zoompan=z='1+0.3*min(on/89,1)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:fps=30:s=1280x720[z0];" +
      "[1:v]zoompan=z='1+0.3*min(on/119,1)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:fps=30:s=1280x720[z1];" +
      "[z0][z1]xfade=transition=fade:duration=0.500:offset=2.500,format=yuv420p[v];" +
      "[0:a][1:a]acrossfade=d=0.500[a]",
    graph,
  );
  // xfade links consume the zoompan outputs, never the raw inputs; the audio
  // chain never touches zoompan (R3's chain verbatim)
  assert.ok(!graph.includes("[0:v][1:v]"), graph);
  assert.equal(argv.filter((a) => a === "-filter_complex").length, 1);
  assert.equal(argv.filter((a) => a === "-i").length, 2);
});

test("builder: chain-path PAN zoom carries the ×2 prescale per input; speed tail unchanged", () => {
  const argv = buildRenderCommand(
    "in.mp4",
    [{ start: 0, end: 3 }, { start: 5, end: 8.5 }],
    "out.mp4",
    {
      ...opts,
      zoom: zx("right", "smooth", 1.2),
      crossfade: { duration: 0.5, kind: "wipeleft" },
      speedFactor: 2,
    },
    true,
  );
  const graph = argv[argv.indexOf("-filter_complex") + 1]!;
  // per-input: scale=2W:2H, then zoompan at the source s=; uniform on BOTH inputs
  for (const k of [0, 1]) {
    assert.ok(graph.includes(`[${k}:v]scale=2560:1440,zoompan=z='1.2'`), graph);
    assert.ok(graph.includes(`:d=1:fps=30:s=1280x720[z${k}]`), graph);
  }
  // speed still composes AFTER the chain (R3), audio untouched by zoompan
  assert.ok(graph.includes("xfade=transition=wipeleft:duration=0.500:offset=2.500,setpts=PTS/2,"), graph);
  assert.ok(graph.includes("acrossfade=d=0.500,atempo=2"), graph);
});

test("builder: export-gif path composes zoom BEFORE the palette suffix (T19 order note)", () => {
  const argv = buildRenderCommand("in.mp4", segs, "out.gif", {
    ...opts, zoom: zx("in", "linear", 1.5), gif: { width: 480, fps: 12 },
  }, true);
  const graph = argv[argv.indexOf("-filter_complex") + 1]!;
  const order = ["select=", "zoompan=", "setpts=N/FRAME_RATE/TB", "fps=12,scale=480:-2:flags=lanczos"];
  let prev = -1;
  for (const part of order) {
    const at = graph.indexOf(part);
    assert.ok(at !== -1, `${part} missing: ${graph}`);
    assert.ok(at > prev, `${part} must come after the previous stage: ${graph}`);
    prev = at;
  }
  assert.ok(graph.includes("palettegen=stats_mode=diff"), graph);
});

test("builder: plans WITHOUT the zoom op produce byte-identical commands (the verbatim no-zoom locks above pin both paths)", () => {
  // explicit canary alongside those locks: the same select and chain inputs
  // with zoom ABSENT contain no zoompan/prescale anywhere
  const select = buildRenderCommand("in.mp4", segs, "out.mp4", opts, true);
  assert.ok(!select.join(" ").includes("zoompan"));
  const chain = buildRenderCommand(
    "in.mp4",
    [{ start: 0, end: 3 }, { start: 5, end: 8.5 }],
    "out.mp4",
    { ...opts, crossfade: { duration: 0.5, kind: "fade" } },
    true,
  );
  assert.ok(!chain.join(" ").includes("zoompan"));
  assert.ok(!chain.join(" ").includes("scale=2560:1440"));
});

// ---- image-overlay (T21; ONE overlay filter fed by an ADDITIONAL input —
// the audio-mix second-input precedent — composing at the drawtext point on
// all three paths; margin 16 px / scale -1 / uniform aa chain are the
// recorded in-task decisions, measured against this ffmpeg build)

const img: ImageOverlayOptions = {
  file: "logo.png",
  position: "bottom-right",
  opacity: 1,
};

test("overlayPositionExpressions: all five positions (fixed 16 px margin, W/H main, w/h overlay)", () => {
  assert.deepEqual(overlayPositionExpressions("top-left"), { x: "16", y: "16" });
  assert.deepEqual(overlayPositionExpressions("top-right"), { x: "W-w-16", y: "16" });
  assert.deepEqual(overlayPositionExpressions("bottom-left"), { x: "16", y: "H-h-16" });
  assert.deepEqual(overlayPositionExpressions("bottom-right"), { x: "W-w-16", y: "H-h-16" });
  assert.deepEqual(overlayPositionExpressions("center"), { x: "(W-w)/2", y: "(H-h)/2" });
});

test("builder: image-overlay flips the select path into -filter_complex (image = input 1, audio keeps -af)", () => {
  const argv = buildRenderCommand("in.mp4", segs, "out.mp4", { ...opts, imageOverlay: img }, true);
  assert.deepEqual(argv, [
    "-nostdin", "-hide_banner", "-y",
    "-i", "in.mp4",
    "-i", "logo.png",
    "-filter_complex",
    "[0:v]select='between(t,0.000,10.000)',setpts=N/FRAME_RATE/TB[vb];" +
      "[1:v]format=rgba,colorchannelmixer=aa=1[im];" +
      "[vb][im]overlay=x=W-w-16:y=H-h-16,format=yuv420p[v]",
    "-map", "[v]",
    "-map", "0:a",
    "-af", "aselect='between(t,0.000,10.000)',asetpts=N/SR/TB",
    "-c:a", "aac", "-b:a", "192k",
    "-c:v", "libx264", "-crf", "18", "-preset", "medium",
    "-movflags", "+faststart", "out.mp4",
  ]);
  // -vf cannot reference a second input — the graph is the ONLY video path
  assert.equal(argv.includes("-vf"), false);
  assert.equal(argv.filter((a) => a === "-i").length, 2);
  assert.equal(argv.filter((a) => a === "-filter_complex").length, 1);
});

test("builder: image-overlay on an audio-less source maps [v] and -an", () => {
  const argv = buildRenderCommand("in.mp4", segs, "out.mp4", { ...opts, imageOverlay: img }, false);
  assert.equal(argv.includes("-af"), false);
  assert.ok(argv.includes("-an"));
  const mapIdx = argv.indexOf("-map");
  assert.deepEqual(argv.slice(mapIdx, mapIdx + 2), ["-map", "[v]"]);
});

test("builder: image-overlay width scale (-1 exact aspect), opacity keel, window math incl. omitted bounds", () => {
  const full = buildRenderCommand("in.mp4", segs, "out.mp4", {
    ...opts,
    imageOverlay: { ...img, width: 120, opacity: 0.35, from: 0.5, to: 2 },
  }, true);
  const g = (argv: string[]) => argv[argv.indexOf("-filter_complex") + 1]!;
  assert.ok(g(full).includes("[1:v]scale=120:-1,format=rgba,colorchannelmixer=aa=0.35[im]"), g(full));
  assert.ok(g(full).includes("overlay=x=W-w-16:y=H-h-16:enable='between(t,0.500,2.000)'"), g(full));

  // from-only / to-only / neither — drawtext's window semantics verbatim
  const fromOnly = buildRenderCommand("in.mp4", segs, "out.mp4", {
    ...opts, imageOverlay: { ...img, from: 1 },
  }, true);
  const toOnly = buildRenderCommand("in.mp4", segs, "out.mp4", {
    ...opts, imageOverlay: { ...img, to: 3.4567 },
  }, true);
  assert.ok(g(fromOnly).includes("enable='gte(t,1.000)'"), g(fromOnly));
  assert.ok(g(toOnly).includes("enable='lte(t,3.457)'"), g(toOnly));
  assert.ok(!g(buildRenderCommand("in.mp4", segs, "out.mp4", { ...opts, imageOverlay: img }, true)).includes("enable="));
});

test("builder: every image-overlay position reaches the graph (x/y verbatim from the table)", () => {
  for (const position of ["top-left", "top-right", "bottom-left", "bottom-right", "center"] as const) {
    const argv = buildRenderCommand("in.mp4", segs, "out.mp4", {
      ...opts, imageOverlay: { ...img, position },
    }, true);
    const graph = argv[argv.indexOf("-filter_complex") + 1]!;
    const { x, y } = overlayPositionExpressions(position);
    assert.ok(graph.includes(`overlay=x=${x}:y=${y}`), `${position}: ${graph}`);
  }
});

test("builder: image-overlay composes at the drawtext point — after zoom/scale/subtitles, before the encoder format", () => {
  const argv = buildRenderCommand("in.mp4", segs, "out.mp4", {
    ...opts,
    speedFactor: 1.25,
    scaleWidth: 640,
    subtitleFile: "subs.srt",
    overlayText: { text: "Title", position: "bottom", fontsize: 48, color: "white", box: true },
    zoom: zx("in", "smooth", 1.3),
    imageOverlay: img,
  }, true);
  const graph = argv[argv.indexOf("-filter_complex") + 1]!;
  const order = [
    "select=",
    "zoompan=",
    "setpts=N/FRAME_RATE/TB/1.25",
    "scale=640:-2",
    "subtitles=",
    "drawtext=",
    "overlay=x=W-w-16:y=H-h-16",
    "format=yuv420p",
  ];
  let prev = -1;
  for (const part of order) {
    const at = graph.indexOf(part);
    assert.ok(at !== -1, `${part} missing: ${graph}`);
    assert.ok(at > prev, `${part} must come after the previous stage: ${graph}`);
    prev = at;
  }
  // the overlay does NOT zoom with the content (anchors on the OUTPUT frame):
  // the overlay link consumes [vb] AFTER zoompan/setpts, never [0:v] raw
  assert.ok(graph.includes("[vb][im]overlay="), graph);
});

test("builder: image-overlay rides the transition chain after the last xfade tail (image = input n)", () => {
  const argv = buildRenderCommand(
    "in.mp4",
    [{ start: 0, end: 3 }, { start: 5, end: 8.5 }],
    "out.mp4",
    { ...opts, imageOverlay: img, crossfade: { duration: 0.5, kind: "fade" } },
    true,
  );
  assert.equal(
    argv[argv.indexOf("-filter_complex") + 1],
    "[0:v][1:v]xfade=transition=fade:duration=0.500:offset=2.500[vc];" +
      "[2:v]format=rgba,colorchannelmixer=aa=1[im];" +
      "[vc][im]overlay=x=W-w-16:y=H-h-16,format=yuv420p[v];" +
      "[0:a][1:a]acrossfade=d=0.500[a]",
  );
  // ONE invocation: 2 source inputs + the image, all in one -filter_complex
  assert.deepEqual(
    argv.filter((_, i) => argv[i - 1] === "-i"),
    ["in.mp4", "in.mp4", "logo.png"],
  );
  assert.equal(argv.filter((a) => a === "-filter_complex").length, 1);
});

test("builder: chain + image-overlay + speed/subtitles/drawtext keeps the tail order, overlay last", () => {
  const argv = buildRenderCommand(
    "in.mp4",
    [{ start: 0, end: 3 }, { start: 5, end: 8.5 }],
    "out.mp4",
    {
      ...opts,
      speedFactor: 2,
      subtitleFile: "subs.srt",
      overlayText: { text: "T", position: "bottom", fontsize: 48, color: "white", box: false },
      imageOverlay: img,
      crossfade: { duration: 0.5, kind: "wipeleft" },
    },
    true,
  );
  const graph = argv[argv.indexOf("-filter_complex") + 1]!;
  const order = ["xfade=transition=wipeleft", "setpts=PTS/2", "subtitles=", "drawtext=", "overlay=x=W-w-16", "format=yuv420p"];
  let prev = -1;
  for (const part of order) {
    const at = graph.indexOf(part);
    assert.ok(at !== -1, `${part} missing: ${graph}`);
    assert.ok(at > prev, `${part} must come after the previous stage: ${graph}`);
    prev = at;
  }
});

test("builder: image-overlay composes before the gif palette suffix (select path, no yuv420p)", () => {
  const argv = buildRenderCommand("in.mp4", segs, "out.gif", {
    ...opts, imageOverlay: img, gif: { width: 480, fps: 12 },
  }, true);
  assert.deepEqual(argv, [
    "-nostdin", "-hide_banner", "-y",
    "-i", "in.mp4",
    "-i", "logo.png",
    "-filter_complex",
    "[0:v]select='between(t,0.000,10.000)',setpts=N/FRAME_RATE/TB[vb];" +
      "[1:v]format=rgba,colorchannelmixer=aa=1[im];" +
      "[vb][im]overlay=x=W-w-16:y=H-h-16," +
      "fps=12,scale=480:-2:flags=lanczos,split[a][b];" +
      "[a]palettegen=stats_mode=diff[p];" +
      "[b][p]paletteuse=dither=bayer:bayer_scale=5[v]",
    "-map", "[v]",
    "-an",
    "out.gif",
  ]);
  assert.equal(argv.includes("-c:v"), false);
});

test("builder: chain + image-overlay hands off to the palette graph at [vx] (window trim stays downstream)", () => {
  const argv = buildRenderCommand(
    "in.mp4",
    [{ start: 0, end: 3 }, { start: 5, end: 8.5 }],
    "out.gif",
    {
      ...opts,
      imageOverlay: img,
      crossfade: { duration: 0.5, kind: "fade" },
      gif: { width: 480, fps: 12, from: 0.5, to: 2 },
    },
    true,
  );
  const graph = argv[argv.indexOf("-filter_complex") + 1]!;
  assert.equal(
    graph,
    "[0:v][1:v]xfade=transition=fade:duration=0.500:offset=2.500[vc];" +
      "[2:v]format=rgba,colorchannelmixer=aa=1[im];" +
      "[vc][im]overlay=x=W-w-16:y=H-h-16[vx];" +
      "[vx]trim=start=0.500:end=2.000,setpts=PTS-STARTPTS," +
      "fps=12,scale=480:-2:flags=lanczos,split[a][b];" +
      "[a]palettegen=stats_mode=diff[p];" +
      "[b][p]paletteuse=dither=bayer:bayer_scale=5[v]",
    graph,
  );
  // the enable window addresses the FULL output timeline (overlay BEFORE the
  // gif window trim) — consistent with the mp4 paths
  assert.ok(graph.indexOf("overlay=") < graph.indexOf("trim="), graph);
});

test("builder: image-overlay + audio-mix share ONE -filter_complex (image is the LAST input, after the bed)", () => {
  const argv = buildRenderCommand("in.mp4", segs, "out.mp4", {
    ...opts, mix, imageOverlay: img,
  }, true);
  assert.deepEqual(
    argv.filter((_, i) => argv[i - 1] === "-i"),
    ["in.mp4", "bed.mp3", "logo.png"],
    argv.join(" "),
  );
  const graph = argv[argv.indexOf("-filter_complex") + 1]!;
  // image input 2 (source 0, bed 1); the validated mix graph rides VERBATIM
  assert.ok(graph.includes("[2:v]format=rgba,colorchannelmixer=aa=1[im]"), graph);
  assert.ok(graph.includes("[main][ducked]amix=inputs=2:duration=first:normalize=0[a]"), graph);
  assert.deepEqual(
    argv.slice(argv.indexOf("-map"), argv.indexOf("-map") + 4),
    ["-map", "[v]", "-map", "[a]"],
  );
  assert.equal(argv.includes("-vf"), false);
  assert.equal(argv.includes("-af"), false);
  assert.equal(argv.filter((a) => a === "-filter_complex").length, 1);
});

test("builder: plans WITHOUT the image op produce byte-identical commands (overlay canary)", () => {
  // the locks above pin the exact graphs; this canary guards the flip itself
  const select = buildRenderCommand("in.mp4", segs, "out.mp4", opts, true);
  assert.ok(!select.join(" ").includes("overlay="));
  assert.ok(!select.join(" ").includes("[im]"));
  assert.equal(select.filter((a) => a === "-i").length, 1);
  assert.notEqual(select.indexOf("-vf"), -1);
  const chain = buildRenderCommand(
    "in.mp4",
    [{ start: 0, end: 3 }, { start: 5, end: 8.5 }],
    "out.mp4",
    { ...opts, crossfade: { duration: 0.5, kind: "fade" } },
    true,
  );
  assert.ok(!chain.join(" ").includes("overlay="));
  assert.ok(!chain.join(" ").includes("[vc]"));
  assert.equal(chain.filter((a) => a === "-i").length, 2);
  const gifv = buildRenderCommand("in.mp4", segs, "out.gif", {
    ...opts, gif: { width: 480, fps: 12 },
  }, true);
  assert.ok(!gifv.join(" ").includes("overlay="));
  assert.equal(gifv.filter((a) => a === "-i").length, 1);
});
