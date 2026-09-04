import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { planWindows } from "../analysis/transcribe/windows.js";
import { parseHandyJson } from "../analysis/transcribe/handy.js";
import { transcribeInput, mapBounded, concurrencyFromBenchmark } from "../analysis/transcribe/index.js";
import { ENGINES, type TranscriptionEngine } from "../analysis/transcribe/engines.js";
import {
  parseWhisperOjf,
  mergeWhisperWords,
  resolveWhisperModel,
  whisperModelUnavailable,
  findWhisperCli,
} from "../analysis/transcribe/whisper.js";
import { Cache } from "../cache/cache.js";
import { ToolError, fail } from "../core/errors.js";
import { runCapture } from "../media/ffprobe.js";
import { detectFillerInstances } from "../analysis/filler.js";
import { WHISPER_OJF_FIXTURE } from "./whisper-fixture.js";

test("windows: fixed chunking without silences", () => {
  const w = planWindows(100, 25);
  assert.deepEqual(
    w.map((x) => [x.start, x.end]),
    [[0, 25], [25, 50], [50, 75], [75, 100]],
  );
});

test("windows: boundaries snap to the nearest silence midpoint", () => {
  const w = planWindows(100, 25, [{ start: 23, end: 27 }, { start: 52, end: 54 }]);
  // ideal 25 -> mid 25 exact; ideal 50 -> mid 53 within radius 25/3
  assert.deepEqual(
    w.map((x) => [x.start, x.end]),
    [[0, 25], [25, 53], [53, 75], [75, 100]],
  );
});

test("windows: silence beyond snap radius of every boundary is ignored", () => {
  const w = planWindows(100, 25, [{ start: 36, end: 38 }]); // mid 37: >25/3 from both 25 and 50
  assert.deepEqual(
    w.map((x) => [x.start, x.end]),
    [[0, 25], [25, 50], [50, 75], [75, 100]],
  );
});

test("windows: boundary guard keeps every tail >= 0.5s", () => {
  const w = planWindows(50.7, 25);
  assert.deepEqual(
    w.map((x) => [x.start, x.end]),
    [[0, 25], [25, 50], [50, 50.7]],
  );
  const w2 = planWindows(50.4, 25); // ideal t=50 fails t < duration-0.5
  assert.deepEqual(
    w2.map((x) => [x.start, x.end]),
    [[0, 25], [25, 50.4]],
  );
});

test("windows: zero duration yields nothing", () => {
  assert.deepEqual(planWindows(0, 25), []);
});

test("parseHandyJson extracts the contract fields", () => {
  const out = JSON.stringify({
    audio_secs: 6.475, best_ms: 1240, bound_backend: "MTL0", load_ms: 509,
    model: "handy-computer/parakeet-tdt-0.6b-v3-gguf/parakeet-tdt-0.6b-v3-Q8_0.gguf",
    rtf: 5.22, text: "Hello world!", transcribe_ms: [1240],
  });
  const r = parseHandyJson(out);
  assert.equal(r.text, "Hello world!");
  assert.ok(r.model.includes("parakeet-tdt-0.6b-v3"));
  assert.equal(r.bestMs, 1240);
});

const transcript = (segs: { s: number; e: number; text: string }[]) => ({
  segments: segs.map((x) => ({ start: x.s, end: x.e, text: x.text })),
});

test("filler: matches single words and phrases with estimated times", () => {
  const instances = detectFillerInstances(
    transcript([{ s: 10, e: 20, text: "So basically we built the toolkit" }]),
  );
  // "basically" is token 1 of 6 -> [11.667, 13.333]
  assert.equal(instances.length, 1);
  assert.equal(instances[0]!.phrase, "basically");
  assert.ok(Math.abs(instances[0]!.start - 11.667) < 0.01);
  assert.ok(Math.abs(instances[0]!.end - 13.333) < 0.01);
});

test("filler: multi-word phrases match and longest wins", () => {
  const instances = detectFillerInstances(
    transcript([{ s: 0, e: 8, text: "you know I mean this works" }]),
    ["you know", "i mean", "you know i mean"],
  );
  assert.deepEqual(instances.map((i) => i.phrase), ["you know i mean"]);
});

test("filler: custom words only, punctuation ignored", () => {
  const instances = detectFillerInstances(
    transcript([{ s: 0, e: 4, text: "Zorp, we did it. Zorp!" }]),
    ["zorp"],
  );
  assert.equal(instances.length, 2);
});

test("filler: empty transcript yields nothing", () => {
  assert.deepEqual(detectFillerInstances(transcript([])), []);
});

// ---- T5: bounded parallel windows (fake engine; no Handy needed) ----
// Fake engines resolve OUT OF ORDER (delay shrinks with index) so the tests
// prove order-independence: results are reassembled in window order no matter
// when each engine call completes. Correctness assertions never depend on
// wall-clock precision — only the completion-order observation does, with
// 45 ms margins between windows.

const FIXTURE = "tone.wav"; // 30 s constant tone -> planWindows(30, 5) = 6 fixed windows
const WINDOW_COUNT = 6;
const FAKES: TranscriptionEngine[] = [];
let dir = "";

interface FakeStats {
  inFlight: number;
  maxInFlight: number;
  completionOrder: number[];
}

function makeFake(
  id: string,
  plan: (i: number) => { delayMs: number; text: string; error?: string },
): { engine: TranscriptionEngine; stats: FakeStats } {
  const stats: FakeStats = { inFlight: 0, maxInFlight: 0, completionOrder: [] };
  const engine: TranscriptionEngine = {
    id,
    describe: `fake engine ${id} (unit test only)`,
    detect: async () => ({ available: true, detail: id }),
    async transcribeWav(wavPath) {
      const i = Number(/chunk_(\d+)\.wav$/.exec(wavPath)?.[1] ?? -1);
      const b = plan(i);
      stats.inFlight++;
      stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, b.delayMs));
        if (b.error) fail("TRANSCRIPTION_ENGINE_FAILED", b.error);
        stats.completionOrder.push(i);
        return { text: b.text, model: `${id}-model`, ms: 5 };
      } finally {
        stats.inFlight--;
      }
    },
  };
  FAKES.push(engine);
  return { engine, stats };
}

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "video-toolkit-t5-"));
  process.chdir(dir);
  const r = await runCapture("ffmpeg", [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=30",
    "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", FIXTURE,
  ]);
  assert.equal(r.code, 0, r.stderr);
});

after(async () => {
  for (const e of FAKES) {
    const idx = ENGINES.indexOf(e);
    if (idx >= 0) ENGINES.splice(idx, 1);
  }
  process.chdir(tmpdir());
  await rm(dir, { recursive: true, force: true });
});

test("mapBounded: out-of-order completion yields index-aligned results within the bound", async () => {
  const items = [0, 1, 2, 3, 4, 5];
  let inFlight = 0;
  let maxInFlight = 0;
  const r = await mapBounded(
    items,
    2,
    async (i) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, (6 - i) * 30)); // reverse completion order
      inFlight--;
      return `w${i}`;
    },
  );
  assert.deepEqual(r, ["w0", "w1", "w2", "w3", "w4", "w5"]);
  assert.equal(maxInFlight, 2); // bound respected and actually reached
});

test("mapBounded: lowest-index failure is the one thrown", async () => {
  // windows 1 and 3 both fail; 3 fails first in time, but 1 wins (sequential semantics)
  await assert.rejects(
    mapBounded([0, 1, 2, 3], 4, async (i) => {
      await new Promise((resolve) => setTimeout(resolve, (4 - i) * 20));
      if (i === 1 || i === 3) throw new Error(`boom-${i}`);
      return i;
    }),
    /boom-1/,
  );
});

test("concurrencyFromBenchmark: measured recommendation when sane, else conservative 1", () => {
  assert.equal(concurrencyFromBenchmark({ recommended: { encoder: "libx264", renderConcurrency: 2 } }), 2);
  assert.equal(concurrencyFromBenchmark({ recommended: { encoder: "libx264", renderConcurrency: 1 } }), 1);
  assert.equal(concurrencyFromBenchmark({ recommended: { renderConcurrency: 3 } }), 3);
  assert.equal(concurrencyFromBenchmark({ recommended: { renderConcurrency: 8 } }), 1); // > engine-safe ceiling 4
  assert.equal(concurrencyFromBenchmark({ recommended: { renderConcurrency: 2.5 } }), 1); // non-integer
  assert.equal(concurrencyFromBenchmark({}), 1);
  assert.equal(concurrencyFromBenchmark(null), 1);
});

test("transcribe: out-of-order engine completion -> source-ordered, byte-identical report", async () => {
  const { engine, stats } = makeFake("fake-oop", (i) => ({
    delayMs: (WINDOW_COUNT - i) * 45, // window 0 slowest: completion order is reversed
    text: `window-${i}`,
  }));
  ENGINES.push(engine);
  const opts = { engine: engine.id, chunkSeconds: 5, noCache: true } as const;

  const seq = await transcribeInput(FIXTURE, { ...opts, concurrency: 1 });
  assert.equal(seq.segments.length, WINDOW_COUNT);
  assert.deepEqual(
    seq.segments.map((s) => s.text),
    ["window-0", "window-1", "window-2", "window-3", "window-4", "window-5"],
  );
  assert.ok(seq.segments.every((s, i) => i === 0 || s.start > seq.segments[i - 1]!.start)); // ascending

  stats.completionOrder.length = 0; // observe only the parallel run
  const par = await transcribeInput(FIXTURE, { ...opts, concurrency: 4 });
  assert.notDeepEqual(stats.completionOrder, [0, 1, 2, 3, 4, 5]); // engine genuinely completed out of order…
  assert.equal(JSON.stringify(par), JSON.stringify(seq)); // …yet the report is byte-identical to sequential
});

test("transcribe: parallelism is bounded by --concurrency (fake engine)", async () => {
  const { engine, stats } = makeFake("fake-bound", (i) => ({
    delayMs: (WINDOW_COUNT - i) * 45,
    text: `w${i}`,
  }));
  ENGINES.push(engine);
  const r = await transcribeInput(FIXTURE, {
    engine: engine.id,
    chunkSeconds: 5,
    concurrency: 2,
    noCache: true,
  });
  assert.equal(r.segments.length, WINDOW_COUNT);
  assert.equal(stats.maxInFlight, 2);
});

test("transcribe: invalid --concurrency -> OPERATION_INVALID", async () => {
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    await assert.rejects(
      transcribeInput(FIXTURE, { engine: "fake-oop", concurrency: bad, noCache: true }),
      (e: unknown) => e instanceof ToolError && e.code === "OPERATION_INVALID",
    );
  }
});

test("transcribe: any window failure fails the task with TRANSCRIPTION_ENGINE_FAILED, no cached report", async () => {
  const { engine } = makeFake("fake-fail", (i) =>
    i === 2
      ? { delayMs: 10, text: "", error: "fake failure at window 2" }
      : { delayMs: (WINDOW_COUNT - i) * 30, text: `w${i}` },
  );
  ENGINES.push(engine);
  await assert.rejects(
    transcribeInput(FIXTURE, { engine: engine.id, chunkSeconds: 5 }), // cache ENABLED: proves no partial write
    (e: unknown) =>
      e instanceof ToolError && e.code === "TRANSCRIPTION_ENGINE_FAILED" && /window 2/.test(e.message),
  );
  const cache = new Cache();
  const id = await cache.sourceId(FIXTURE);
  const files = await readdir(path.join(".video-agent/cache", id)).catch(() => [] as string[]);
  assert.ok(
    files.every((f) => !f.startsWith("transcript-fake-fail")),
    `no transcript cache file expected, saw: ${JSON.stringify(files)}`,
  );
});

test("transcribe: cache key unchanged — warm cache hits regardless of concurrency", async () => {
  const { engine } = makeFake("fake-cache", (i) => ({ delayMs: 5, text: `w${i}` }));
  ENGINES.push(engine);
  const first = await transcribeInput(FIXTURE, { engine: engine.id, chunkSeconds: 5 }); // miss -> write
  const lines: string[] = [];
  const hit = await transcribeInput(FIXTURE, {
    engine: engine.id,
    chunkSeconds: 5,
    concurrency: 4, // different concurrency, same key
    debug: (l) => lines.push(l),
  });
  assert.ok(
    lines.some((l) => l.includes("cache hit: transcript-fake-cache")),
    lines.join("; "),
  );
  assert.equal(JSON.stringify(hit), JSON.stringify(first));
});

// ---- T10: whisper-cpp engine — parser (committed fixture), routing, cache key ----
// No live whisper-cli here: the parser runs against the committed fixture
// (src/test/whisper-fixture.ts, captured from the R2-committed invocation);
// routing/cache tests use fake native engines.

test("whisper merge: specials skipped, leading space starts a word, tails append+extend", () => {
  const w = mergeWhisperWords([
    { text: "[_BEG_]", offsets: { from: 0, to: 0 } },
    { text: " Um", offsets: { from: 10, to: 140 } },
    { text: ",", offsets: { from: 140, to: 270 } },
    { text: " you", offsets: { from: 400, to: 500 } },
    { text: "[_TT_198]", offsets: { from: 3960, to: 3960 } },
  ]);
  assert.deepEqual(w, [
    { text: "Um,", start: 10, end: 270 },
    { text: "you", start: 400, end: 500 },
  ]);
});

test("whisper merge: BPE continuation pieces append without extending end backwards", () => {
  const w = mergeWhisperWords([
    { text: " align", offsets: { from: 100, to: 200 } },
    { text: "ment", offsets: { from: 150, to: 180 } }, // tail ends BEFORE the word's end
    { text: ".", offsets: { from: 260, to: 300 } },
  ]);
  assert.deepEqual(w, [{ text: "alignment.", start: 100, end: 300 }]); // end = max(...)
});

test("whisper merge: zero-width word repaired from the next word in the SAME segment; last stays zero", () => {
  const w = mergeWhisperWords([
    { text: " So", offsets: { from: 4320, to: 4320 } },
    { text: " basically", offsets: { from: 4330, to: 5400 } },
    { text: " end", offsets: { from: 6000, to: 6000 } }, // no next word -> left as-is
  ]);
  assert.deepEqual(w.map((x) => [x.start, x.end]), [[4320, 4330], [4330, 5400], [6000, 6000]]);
});

test("whisper merge: repair never invents data when the next word starts at the same time", () => {
  const w = mergeWhisperWords([
    { text: " know", offsets: { from: 13360, to: 13360 } },
    { text: " what", offsets: { from: 13360, to: 13570 } },
  ]);
  assert.deepEqual(w.map((x) => [x.start, x.end]), [[13360, 13360], [13360, 13570]]);
});

test("whisper parser: committed fixture -> segments + words per the R2 contract", () => {
  const { segments, language } = parseWhisperOjf(WHISPER_OJF_FIXTURE);
  assert.equal(language, "en");
  assert.equal(segments.length, 3);
  // ms -> seconds at 3 decimals (INVARIANT 4)
  assert.deepEqual(
    segments.map((s) => [s.start, s.end]),
    [[0, 3.96], [4.32, 9.36], [9.76, 14]],
  );
  assert.equal(segments[0]!.text, "Um, you know, I was basically thinking about the alignment problem.");
  // punctuation merge: "Um" + "," ; word text keeps emitted punctuation
  const s0 = segments[0]!.words!;
  assert.equal(s0[0]!.text, "Um,");
  assert.equal(s0[0]!.start, 0.01);
  assert.equal(s0[0]!.end, 0.27);
  assert.equal(s0[s0.length - 1]!.text, "problem."); // trailing "." appended
  assert.equal(s0[s0.length - 1]!.end, 3.96); // degenerate token extended to segment end
  // deterministic repair visible in seg1 (So 4320->4330) and seg2 (know stays zero-width)
  const s1 = segments[1]!.words!;
  assert.equal(s1[0]!.text, "So");
  assert.deepEqual([s1[0]!.start, s1[0]!.end], [4.32, 4.33]);
  const s2 = segments[2]!.words!;
  const know = s2.find((w) => w.text === "know")!;
  assert.deepEqual([know.start, know.end], [13.36, 13.36]);
  // sanity contract: ordered, non-overlapping, within segment bounds, 3 decimals
  for (const seg of segments) {
    let prevEnd = seg.start;
    for (const w of seg.words!) {
      assert.ok(w.start >= prevEnd - 0.0005, `word overlap at ${w.start} after ${prevEnd}: ${w.text}`);
      assert.ok(w.end >= w.start, `negative span: ${w.text}`);
      assert.ok(w.start >= seg.start - 0.0005 && w.end <= seg.end + 0.0005, `out of bounds: ${w.text}`);
      assert.ok(Number.isInteger(Math.round(w.start * 1000)) && Number.isInteger(Math.round(w.end * 1000)));
      prevEnd = w.end;
    }
  }
  assert.equal(segments.reduce((n, s) => n + s.words!.length, 0), 39); // 11 + 13 + 15
});

test("whisper parser: invalid JSON -> TRANSCRIPTION_ENGINE_FAILED; empty-text segments skipped", () => {
  assert.throws(() => parseWhisperOjf("not json{"), (e: unknown) =>
    e instanceof ToolError && e.code === "TRANSCRIPTION_ENGINE_FAILED");
  const doc = JSON.stringify({
    transcription: [
      { offsets: { from: 0, to: 500 }, text: "   ", tokens: [] },
      { offsets: { from: 500, to: 900 }, text: " hello", tokens: [{ text: " hello", offsets: { from: 510, to: 700 } }] },
    ],
  });
  const { segments } = parseWhisperOjf(doc);
  assert.equal(segments.length, 1);
  assert.equal(segments[0]!.text, "hello");
  assert.equal(segments[0]!.words!.length, 1);
});

// fake NATIVE engine: reports transcribeSegments; proves the orchestrator
// honors the capability (one whole-file invocation, no windows)
function makeFakeNative(id: string, segs: { s: number; e: number; text: string; words: { s: number; e: number; t: string }[] }[]) {
  let calls = 0;
  const engine: TranscriptionEngine = {
    id,
    describe: `fake native engine ${id} (unit test only)`,
    detect: async () => ({ available: true, detail: id }),
    async transcribeWav() {
      fail("TRANSCRIPTION_ENGINE_FAILED", "fake native engine must not be windowed");
    },
    async transcribeSegments(_wav, opts) {
      calls++;
      const words = opts.words === true;
      return {
        segments: segs.map((x) => ({
          start: x.s,
          end: x.e,
          text: x.text,
          ...(words ? { words: x.words.map((w) => ({ start: w.s, end: w.e, text: w.t })) } : {}),
        })),
        model: `${id}-model`,
        ms: 5,
        language: "en",
      };
    },
  };
  return {
    engine,
    calls: () => calls,
    register: () => ENGINES.push(engine),
    unregister: () => {
      const i = ENGINES.indexOf(engine);
      if (i >= 0) ENGINES.splice(i, 1);
    },
  };
}

const NATIVE_SEGS = [
  { s: 0, e: 3.96, text: "Um, you know.", words: [{ s: 0.01, e: 0.27, t: "Um," }, { s: 0.4, e: 0.5, t: "you" }, { s: 0.5, e: 0.84, t: "know." }] },
  { s: 4.32, e: 9.36, text: "So basically.", words: [{ s: 4.32, e: 4.33, t: "So" }, { s: 4.33, e: 5.4, t: "basically." }] },
];

test("transcribe: --word-timestamps + word-incapable engine -> OPERATION_INVALID (param guard)", async () => {
  for (const id of ["handy", "fake-oop"]) {
    // handy may not be installed — the guard fires before any detect/spawn
    await assert.rejects(
      transcribeInput(FIXTURE, { engine: id, wordTimestamps: true, noCache: true }),
      (e: unknown) =>
        e instanceof ToolError && e.code === "OPERATION_INVALID" && /word-capable/.test(e.message),
    );
  }
});

test("transcribe: native engine -> ONE whole-file invocation, words honored, chunk ignored", async () => {
  const fake = makeFakeNative("fake-native", NATIVE_SEGS);
  fake.register();
  try {
    const r = await transcribeInput(FIXTURE, {
      engine: fake.engine.id,
      wordTimestamps: true,
      chunkSeconds: 5, // would be 6 windows if windowed
      concurrency: 4, // no-op for native engines
      noCache: true,
    });
    assert.equal(fake.calls(), 1); // no windowing, no parallel re-invocation
    assert.equal(r.engine, "fake-native");
    assert.equal(r.language, "en");
    assert.equal(r.params?.wordTimestamps, true);
    assert.deepEqual(
      r.segments.map((s) => s.words!.map((w) => w.text)),
      [["Um,", "you", "know."], ["So", "basically."]],
    );
    const plain = await transcribeInput(FIXTURE, { engine: fake.engine.id, noCache: true });
    assert.equal(fake.calls(), 2); // still one invocation per run
    assert.ok(plain.segments.every((s) => !("words" in s))); // segments WITHOUT words when not requested
    assert.equal(plain.params?.wordTimestamps, false);
    assert.equal(plain.params?.chunkSeconds, undefined); // native params carry no windowing facts
  } finally {
    fake.unregister();
  }
});

test("transcribe: native cache key transcript-<engine>-<model>-c0-w<0|1>.json; words flag toggles miss", async () => {
  const fake = makeFakeNative("fake-native-cache", NATIVE_SEGS);
  fake.register();
  try {
    await transcribeInput(FIXTURE, { engine: fake.engine.id, wordTimestamps: true }); // miss -> write w1
    const w1lines: string[] = [];
    await transcribeInput(FIXTURE, {
      engine: fake.engine.id,
      wordTimestamps: true,
      debug: (l) => w1lines.push(l),
    });
    assert.ok(
      w1lines.some((l) => l.includes("cache hit: transcript-fake-native-cache-default-c0-w1.json")),
      w1lines.join("; "),
    );
    const w0lines: string[] = [];
    await transcribeInput(FIXTURE, {
      engine: fake.engine.id, // no words flag -> DIFFERENT key, must MISS
      debug: (l) => w0lines.push(l),
    });
    assert.ok(
      w0lines.some((l) => l.includes("cache miss: wrote transcript-fake-native-cache-default-c0-w0.json")),
      w0lines.join("; "),
    );
    // structural: native keys never collide with windowed entries (windowed
    // keys are -c<chunk>.json with no -w suffix, from real chunk values)
    const cache = new Cache();
    const id = await cache.sourceId(FIXTURE);
    const files = await readdir(path.join(".video-agent/cache", id));
    assert.ok(files.includes("transcript-fake-native-cache-default-c0-w1.json"));
    assert.ok(files.includes("transcript-fake-native-cache-default-c0-w0.json"));
    assert.ok(files.every((f) => !f.startsWith("transcript-fake-native-cache") || /-c0-w[01]\.json$/.test(f)));
  } finally {
    fake.unregister();
  }
});

test("transcribe: --word-timestamps with no engine selects whisper-cpp; unavailable -> TRANSCRIPTION_ENGINE_UNAVAILABLE", async () => {
  // unit tmp cwd has no .video-agent/models -> the whisper-cpp engine is
  // unavailable here no matter the binary; the failure must name it
  await assert.rejects(
    transcribeInput(FIXTURE, { wordTimestamps: true, noCache: true }),
    (e: unknown) =>
      e instanceof ToolError &&
      e.code === "TRANSCRIPTION_ENGINE_UNAVAILABLE" &&
      /whisper-cpp/.test(e.message),
  );
});

test("whisper model resolution: R2 ordered table (explicit path > models-dir name > default > listing error)", async () => {
  const modelsDir = path.join(".video-agent", "models");
  await mkdir(modelsDir, { recursive: true });
  try {
    await writeFile(path.join(modelsDir, "aa.bin"), "");
    await writeFile(path.join(modelsDir, "ggml-base.en.bin"), "");
    await writeFile("explicit.bin", "");
    await writeFile(path.join(modelsDir, "dup.bin"), "");
    await writeFile("dup.bin", "");

    // rule 1: explicit existing path wins verbatim (even over a models-dir name)
    assert.equal(resolveWhisperModel("explicit.bin"), "explicit.bin");
    assert.equal(resolveWhisperModel("dup.bin"), "dup.bin");
    // rule 2: models-dir name
    assert.equal(resolveWhisperModel("aa.bin"), path.join(modelsDir, "aa.bin"));
    // rule 3: provisioned default
    assert.equal(resolveWhisperModel(undefined), path.join(modelsDir, "ggml-base.en.bin"));
    // rule 4: unresolvable -> null + machine-readable listing
    assert.equal(resolveWhisperModel("missing.bin"), null);
    assert.throws(
      () => whisperModelUnavailable("missing.bin"),
      (e: unknown) =>
        e instanceof ToolError &&
        e.code === "TRANSCRIPTION_ENGINE_UNAVAILABLE" &&
        JSON.stringify((e as ToolError).details?.known) === JSON.stringify(["aa.bin", "dup.bin", "ggml-base.en.bin"]),
    );
  } finally {
    await rm(modelsDir, { recursive: true, force: true });
    await rm("explicit.bin", { force: true });
    await rm("dup.bin", { force: true });
  }
  // absent models dir -> null + note says so
  assert.equal(resolveWhisperModel(undefined), null);
  assert.throws(
    () => whisperModelUnavailable(),
    (e: unknown) =>
      e instanceof ToolError && e.code === "TRANSCRIPTION_ENGINE_UNAVAILABLE" &&
      String((e as ToolError).details?.note).includes("not found"),
  );
});

test("whisper detect(): binary+model facts in the detail (no models dir -> unavailable)", async () => {
  const { whisperEngine } = await import("../analysis/transcribe/engines.js");
  const d = await whisperEngine.detect();
  const hasCli = (await findWhisperCli()) !== null;
  assert.equal(d.available, false); // no default model in the unit tmp cwd
  assert.ok(d.detail.includes("whisper-cli") || hasCli === false);
  assert.ok(d.detail.includes("ggml-base.en.bin"));
});
