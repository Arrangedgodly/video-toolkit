import { test } from "node:test";
import assert from "node:assert/strict";
import { planWindows } from "../analysis/transcribe/windows.js";
import { parseHandyJson } from "../analysis/transcribe/handy.js";
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
