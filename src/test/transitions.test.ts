import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ToolError } from "../core/errors.js";
import { CROSSFADE_KINDS } from "../core/schemas.js";
import {
  parseXfadeTransitions,
  assertCatalogCoversAllowlist,
  extrasBeyondAllowlist,
  catalogTransitions,
  transitionsCacheName,
} from "../media/transitions.js";
import { XFADE_HELP_FIXTURE } from "./xfade-help-fixture.js";

// Unit tests parse the COMMITTED fixture (this build's help text verbatim) —
// no live ffmpeg. Live integration tests at the bottom prove the real build
// still matches. Mirrors the whisper-fixture.ts precedent (T10).

const FIXTURE_KINDS = parseXfadeTransitions(XFADE_HELP_FIXTURE);

test("parser: fixture → 58 kinds, help order kept, custom sentinel excluded", () => {
  assert.equal(FIXTURE_KINDS.length, 58);
  assert.equal(FIXTURE_KINDS[0], "fade");
  assert.equal(FIXTURE_KINDS[1], "wipeleft");
  assert.equal(FIXTURE_KINDS[FIXTURE_KINDS.length - 1], "revealdown");
  // anchor positions = the enum's own integer values (fadeblack 12, dissolve 25)
  assert.equal(FIXTURE_KINDS[12], "fadeblack");
  assert.equal(FIXTURE_KINDS[25], "dissolve");
  // `custom` (enum −1) is a placeholder requiring expr=, never a catalog kind
  assert.ok(!FIXTURE_KINDS.includes("custom"));
  // deterministic: same text in, same array out
  assert.deepEqual(parseXfadeTransitions(XFADE_HELP_FIXTURE), FIXTURE_KINDS);
});

test("parser: the catalog EQUALS the schema allowlist (T17, both directions)", () => {
  // deepEqual is bidirectional and order-sensitive: no allowlisted kind
  // missing from the catalog, no catalog kind left out of the allowlist,
  // help listing order pinned. (T12's superset law inverted by T17: the
  // allowlist is now the FULL verified catalog.)
  assert.deepEqual(FIXTURE_KINDS, [...CROSSFADE_KINDS]);
  assert.equal(FIXTURE_KINDS.length, 58);
  // the expr= sentinel is on neither side
  assert.equal(CROSSFADE_KINDS.includes("custom" as (typeof CROSSFADE_KINDS)[number]), false);
});

test("parser: garbled or absent filter help → FILTER_HELP_UNPARSEABLE", () => {
  const cases: string[] = [
    "", // empty stdout (e.g. help went nowhere)
    "Unknown filter 'xfade'.\n", // build without the filter (stdout form)
    "Filter xfade\n  Cross fade one video with another video.\n", // no AVOptions block
  ];
  for (const text of cases) {
    assert.throws(
      () => parseXfadeTransitions(text),
      (e: unknown) => e instanceof ToolError && e.code === "FILTER_HELP_UNPARSEABLE",
      `should refuse to parse: ${JSON.stringify(text.slice(0, 40))}`,
    );
  }
});

test("parser: a transition option with no parsable enum entries is refused", () => {
  const drifted = "xfade AVOptions:\n   transition        <int>        ..FV....... (format drift)\n";
  assert.throws(
    () => parseXfadeTransitions(drifted),
    (e: unknown) => e instanceof ToolError && e.code === "FILTER_HELP_UNPARSEABLE",
  );
});

test("parser: negative enum values are excluded as sentinels (pure rule)", () => {
  const mini = [
    "Filter xfade",
    "xfade AVOptions:",
    "   transition        <int>        ..FV....... set cross fade transition (from -1 to 1)",
    "     custom          -1           ..FV....... custom transition",
    "     fade            0            ..FV....... fade transition",
    "     wipeleft        1            ..FV....... wipe left transition",
    "   duration          <duration>   ..FV....... set cross fade duration (default 1)",
  ].join("\n");
  assert.deepEqual(parseXfadeTransitions(mini), ["fade", "wipeleft"]);
});

test("coverage guard: a catalog missing an allowlisted kind fails loudly, naming it", () => {
  assert.throws(
    () => assertCatalogCoversAllowlist(["fade", "wipeleft"], "9.0.1"),
    (e: unknown) =>
      e instanceof ToolError &&
      e.code === "FILTER_HELP_UNPARSEABLE" &&
      e.message.includes("circleopen") &&
      e.message.includes("radial") &&
      e.message.includes("allowlisted"),
  );
  // and the pinned build's full catalog passes silently
  assert.doesNotThrow(() => assertCatalogCoversAllowlist(FIXTURE_KINDS, "9.0.1"));
});

test("extras rule: kinds beyond the allowlist are pure data, never a failure", () => {
  // the pinned build lists nothing beyond the allowlist
  assert.deepEqual(extrasBeyondAllowlist(FIXTURE_KINDS), []);
  // an upgraded build's extras surface as data (the report note) — discovery
  // must survive an ffmpeg upgrade
  assert.deepEqual(extrasBeyondAllowlist([...FIXTURE_KINDS, "newhotness", "custom"]), [
    "newhotness",
    "custom",
  ]);
});

// ---- live integration (this suite already requires ffmpeg on PATH) ----

test("live: catalogTransitions shape, coverage, no sentinel, no drift note (no-cache)", async () => {
  const report = await catalogTransitions({ noCache: true });
  assert.ok(Array.isArray(report.transitions) && report.transitions.length > 0);
  assert.equal(report.count, report.transitions.length);
  assert.match(report.ffmpeg, /\S+/);
  const kinds = report.transitions.map((t) => t.kind);
  assert.ok(!kinds.includes("custom"));
  // this build lists nothing beyond the allowlist → no drift note
  assert.equal(report.note, undefined);
  assert.doesNotThrow(() => assertCatalogCoversAllowlist(kinds, report.ffmpeg));
});

test("live: this build still parses to the committed fixture's catalog", async () => {
  const report = await catalogTransitions({ noCache: true });
  assert.deepEqual(
    report.transitions.map((t) => t.kind),
    FIXTURE_KINDS,
    "this ffmpeg build's xfade enum changed vs src/test/xfade-help-fixture.ts — re-capture the fixture",
  );
});

test("live: the live catalog EQUALS the schema allowlist (T17 cross-check b)", async () => {
  const report = await catalogTransitions({ noCache: true });
  // deepEqual = equality in BOTH directions against the live build, not the
  // fixture: allowlist == catalog on the pinned build, no re-derivation drift
  assert.deepEqual(
    report.transitions.map((t) => t.kind),
    [...CROSSFADE_KINDS],
    "the live xfade enum drifted from CROSSFADE_KINDS — an upgrade needs the T17 re-verification sweep and a re-derived allowlist",
  );
  assert.equal(report.count, CROSSFADE_KINDS.length);
});

test("live: cache keyed by ffmpeg version — written, hit, and guarded", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "video-transitions-"));
  const prev = process.cwd();
  process.chdir(dir);
  try {
    const first = await catalogTransitions();
    const file = path.join(".video-agent", "cache", "env", transitionsCacheName(first.ffmpeg));
    await stat(file); // written under the environment-keyed id

    let sawHit = false;
    const second = await catalogTransitions({ debug: (l) => { if (l.includes("cache hit")) sawHit = true; } });
    assert.ok(sawHit, "second call should hit the cache");
    assert.deepEqual(second, first);

    // a tampered/stale cache that dropped a frozen kind must NOT be served
    await writeFile(
      file,
      JSON.stringify({ transitions: [{ kind: "fade" }], count: 1, ffmpeg: first.ffmpeg }),
    );
    await assert.rejects(
      () => catalogTransitions(),
      (e: unknown) =>
        e instanceof ToolError &&
        e.code === "FILTER_HELP_UNPARSEABLE" &&
        e.message.includes("wipeleft"),
    );
  } finally {
    process.chdir(prev);
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- CLI surface (spawns the built binary, like cli.test.ts) ----

const BIN = path.resolve(import.meta.dirname, "..", "cli", "index.js");

function run(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d));
    child.stderr.on("data", (d: Buffer) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

test("CLI: transitions emits compact single-line JSON with the catalog", async () => {
  const r = await run("transitions", "--no-cache");
  assert.equal(r.code, 0);
  assert.equal(r.stderr, "");
  assert.equal(r.stdout.trim().split("\n").length, 1, "compact output is one line");
  const data = JSON.parse(r.stdout) as { transitions: { kind: string }[]; count: number; ffmpeg: string };
  assert.equal(data.count, data.transitions.length);
  // the CLI catalog IS the allowlist on this build (smoke per the T17 plan)
  assert.equal(data.count, CROSSFADE_KINDS.length);
  assert.deepEqual(
    data.transitions.map((t) => t.kind),
    [...CROSSFADE_KINDS],
  );
});

test("CLI: transitions --pretty pretty-prints the same catalog", async () => {
  const r = await run("transitions", "--pretty", "--no-cache");
  assert.equal(r.code, 0);
  assert.ok(r.stdout.trim().split("\n").length > 1, "--pretty is multi-line");
  const data = JSON.parse(r.stdout) as { count: number };
  assert.ok(data.count > 0);
});
