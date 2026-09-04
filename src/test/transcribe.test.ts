import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { planWindows } from "../analysis/transcribe/windows.js";
import { parseHandyJson } from "../analysis/transcribe/handy.js";
import { transcribeInput, mapBounded, concurrencyFromBenchmark } from "../analysis/transcribe/index.js";
import { ENGINES, type TranscriptionEngine } from "../analysis/transcribe/engines.js";
import { Cache } from "../cache/cache.js";
import { ToolError, fail } from "../core/errors.js";
import { runCapture } from "../media/ffprobe.js";
import { detectFillerInstances } from "../analysis/filler.js";

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
