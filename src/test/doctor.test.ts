import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  aggregateDoctorChecks,
  nodeEnginesFloor,
  runDoctor,
  type AggregatableCheck,
  type DoctorProbes,
  type DoctorReport,
} from "../doctor/doctor.js";
import { binaryPath, hasFilter, listEncoders, OVERLAY_FONT_FILE } from "../media/ffmpeg.js";
import { stat } from "node:fs/promises";
import { findHandy } from "../analysis/transcribe/handy.js";
import { findWhisperCli, resolveWhisperModel, whisperToolkitRoot } from "../analysis/transcribe/whisper.js";
import { readFileSync } from "node:fs";

// `video doctor` (T29). Three layers, the established split:
//   1. PURE units over fake check sets (the aggregation law)
//   2. runDoctor units over INJECTED fake probes (broken/degraded paths —
//      no environment mutation)
//   3. LIVE CLI run asserting the real machine's report CONSISTENT with the
//      actual probe results (the primitives, re-derived independently)

const CHECK_NAMES = [
  "node",
  "ffmpeg",
  "ffprobe",
  "filter-subtitles",
  "filter-drawtext",
  "encoders",
  "overlay-font",
  "engine-handy",
  "engine-whisper",
  "say",
  "cache-cwd",
  "cache-toolkit-root",
] as const;

function check(name: string, status: "ok" | "missing" | "degraded", core: boolean): AggregatableCheck {
  return { name, status, detail: `${name} ${status}`, core };
}

// ---- 1. pure aggregation law ----

test("aggregation: all ok → status ok, exact tallies", () => {
  const { status, counts } = aggregateDoctorChecks(CHECK_NAMES.map((n) => check(n, "ok", n === "node" || n === "ffmpeg" || n === "ffprobe")));
  assert.equal(status, "ok");
  assert.deepEqual(counts, { ok: CHECK_NAMES.length, degraded: 0, missing: 0 });
});

test("aggregation: optional check missing or degraded → status degraded", () => {
  const base = (s: "ok" | "missing" | "degraded") =>
    CHECK_NAMES.map((n) => check(n, n === "say" ? s : "ok", n === "node" || n === "ffmpeg" || n === "ffprobe"));
  assert.equal(aggregateDoctorChecks(base("missing")).status, "degraded");
  assert.equal(aggregateDoctorChecks(base("degraded")).status, "degraded");
  assert.deepEqual(aggregateDoctorChecks(base("missing")).counts, {
    ok: CHECK_NAMES.length - 1,
    degraded: 0,
    missing: 1,
  });
});

test("aggregation: ANY non-ok core check → broken (missing, degraded, node-too-old alike)", () => {
  for (const core of ["node", "ffmpeg", "ffprobe"] as const) {
    for (const s of ["missing", "degraded"] as const) {
      const checks = CHECK_NAMES.map((n) =>
        check(n, n === core ? s : "ok", n === "node" || n === "ffmpeg" || n === "ffprobe"),
      );
      const { status, counts } = aggregateDoctorChecks(checks);
      assert.equal(status, "broken", `${core} ${s} must be broken`);
      assert.equal(counts.missing + counts.degraded, 1);
    }
  }
});

test("aggregation: broken beats degraded; counts stay exact tallies", () => {
  const checks = CHECK_NAMES.map((n) => {
    if (n === "ffmpeg") return check(n, "missing", true);
    if (n === "say" || n === "cache-cwd") return check(n, n === "say" ? "missing" : "degraded", false);
    return check(n, "ok", n === "node" || n === "ffprobe");
  });
  const { status, counts } = aggregateDoctorChecks(checks);
  assert.equal(status, "broken");
  assert.deepEqual(counts, { ok: CHECK_NAMES.length - 3, degraded: 1, missing: 2 });
});

test("aggregation: empty set → ok with zero tallies (degenerate law)", () => {
  assert.deepEqual(aggregateDoctorChecks([]), { status: "ok", counts: { ok: 0, degraded: 0, missing: 0 } });
});

// ---- engines floor parsing (pure) ----

test("nodeEnginesFloor: >=N comparator, drift fallback, unconstrained", () => {
  assert.equal(nodeEnginesFloor(">=20"), 20);
  assert.equal(nodeEnginesFloor(">= 20"), 20);
  assert.equal(nodeEnginesFloor("^20.1.0"), 20); // comparator drift → first integer
  assert.equal(nodeEnginesFloor(undefined), null);
  assert.equal(nodeEnginesFloor("latest"), null);
});

// ---- 2. runDoctor over injected fake probes ----

function fakeProbes(over: Partial<DoctorProbes> = {}): DoctorProbes {
  return {
    nodeVersion: () => "24.6.0",
    enginesNodeSpec: () => ">=20",
    resolveBinary: async (name) => `/opt/bin/${name}`,
    ffmpegVersion: async () => "9.0.1",
    encoders: async () => [
      { name: "libx264", codec: "h264", hardware: false },
      { name: "h264_videotoolbox", codec: "h264", hardware: true },
    ],
    filterPresent: async () => true,
    filePresent: async () => true,
    findHandy: async () => "/Applications/Handy.app/Contents/MacOS/handy",
    findWhisperCli: async () => "/opt/bin/whisper-cli",
    resolveWhisperModel: () => "/repo/.video-agent/models/ggml-base.en.bin",
    listModelBins: () => ["ggml-base.en.bin"],
    dirWritable: async () => true,
    ...over,
  };
}

test("runDoctor (fake probes): fully healthy environment → ok, 12 checks in fixed order", async () => {
  const report = await runDoctor(fakeProbes());
  assert.equal(report.status, "ok");
  assert.deepEqual(report.checks.map((c) => c.name), [...CHECK_NAMES]);
  assert.deepEqual(report.counts, { ok: CHECK_NAMES.length, degraded: 0, missing: 0 });
  assert.deepEqual(report.engines, { handy: true, whisper: true });
  // ok checks carry no impact/remediation (nothing to fix)
  for (const c of report.checks) {
    assert.equal(c.status, "ok");
    assert.equal(c.impact, undefined);
    assert.equal(c.remediation, undefined);
    assert.ok(c.detail.length > 0);
  }
});

test("runDoctor (fake probes): ffmpeg missing → broken, check names impact + remediation", async () => {
  const report = await runDoctor(
    fakeProbes({
      resolveBinary: async (name) => (name === "ffmpeg" ? null : `/opt/bin/${name}`),
      // mirrors reality: an absent ffmpeg probes no filters and no encoders
      filterPresent: async () => false,
      encoders: async () => [],
    }),
  );
  assert.equal(report.status, "broken");
  const ffmpeg = report.checks.find((c) => c.name === "ffmpeg")!;
  assert.equal(ffmpeg.status, "missing");
  assert.ok(ffmpeg.impact!.includes("every command"));
  assert.ok(ffmpeg.remediation!.includes("install ffmpeg"));
  // the capability checks over an absent ffmpeg report missing (not ok)
  assert.equal(report.checks.find((c) => c.name === "filter-subtitles")!.status, "missing");
  assert.equal(report.checks.find((c) => c.name === "encoders")!.status, "missing");
  assert.deepEqual(report.counts, { ok: CHECK_NAMES.length - 4, degraded: 0, missing: 4 });
});

test("runDoctor (fake probes): node below engines → broken with the required floor", async () => {
  const report = await runDoctor(fakeProbes({ nodeVersion: () => "18.19.1" }));
  assert.equal(report.status, "broken");
  const node = report.checks.find((c) => c.name === "node")!;
  assert.equal(node.status, "missing");
  assert.ok(node.detail.includes("v18.19.1"));
  assert.ok(node.detail.includes(">=20"));
  assert.ok(node.remediation!.includes("install node >= 20"));
});

test("runDoctor (fake probes): optional capabilities missing → degraded, never broken", async () => {
  const report = await runDoctor(
    fakeProbes({
      filterPresent: async (f) => f !== "subtitles", // libass absent
      encoders: async () => [{ name: "libx264", codec: "h264", hardware: false }], // no hw
      filePresent: async () => false, // overlay font absent
      findHandy: async () => null,
      findWhisperCli: async () => null,
      resolveBinary: async (name) => (name === "say" ? null : `/opt/bin/${name}`),
    }),
  );
  assert.equal(report.status, "degraded");
  assert.deepEqual(report.engines, { handy: false, whisper: false });
  const by = (n: string) => report.checks.find((c) => c.name === n)!;
  // impact strings name the affected ops/commands
  assert.ok(by("filter-subtitles").impact!.includes("captions"));
  assert.ok(by("filter-drawtext").status === "ok");
  assert.ok(by("encoders").status === "degraded");
  assert.ok(by("encoders").impact!.includes("h264_videotoolbox"));
  assert.ok(by("overlay-font").impact!.includes("overlay-text"));
  assert.ok(by("engine-handy").impact!.includes("--engine handy"));
  assert.ok(by("engine-whisper").impact!.includes("whisper-cpp"));
  assert.equal(by("say").status, "missing");
  assert.ok(by("say").impact!.includes("informational"));
});

test("runDoctor (fake probes): whisper-cli present without a model → missing + BOTH dirs listed", async () => {
  const report = await runDoctor(
    fakeProbes({
      resolveWhisperModel: () => null,
      listModelBins: (dir) => (dir.includes("toolkit") ? ["ggml-small.en.bin"] : []),
    }),
  );
  const w = report.checks.find((c) => c.name === "engine-whisper")!;
  assert.equal(w.status, "missing");
  assert.equal(report.engines.whisper, false);
  assert.ok(w.detail.includes("no model resolvable"));
  assert.ok(w.detail.includes("ggml-small.en.bin"), "found-models listing present");
  assert.ok(w.remediation!.includes(".video-agent/models"));
});

test("runDoctor (fake probes): unwritable caches → degraded checks, still never broken", async () => {
  const report = await runDoctor(fakeProbes({ dirWritable: async () => false }));
  assert.equal(report.status, "degraded");
  assert.equal(report.checks.find((c) => c.name === "cache-cwd")!.status, "degraded");
  assert.equal(report.checks.find((c) => c.name === "cache-toolkit-root")!.status, "degraded");
});

test("runDoctor (fake probes): determinism — identical probes, byte-identical report", async () => {
  const probes = fakeProbes({ findHandy: async () => null });
  assert.deepEqual(await runDoctor(probes), await runDoctor(probes));
});

// ---- 3. live CLI run: the real machine's report vs its own probe results ----

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

test("live CLI: doctor reports the real machine, consistent with the actual probes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "video-doctor-"));
  const prev = process.cwd();
  process.chdir(dir);
  try {
    const r = await run("doctor");
    assert.equal(r.stderr, "");
    assert.equal(r.stdout.trim().split("\n").length, 1, "compact output is one line");
    const report = JSON.parse(r.stdout) as DoctorReport;

    assert.deepEqual(report.checks.map((c) => c.name), [...CHECK_NAMES]);
    assert.deepEqual(report.counts, {
      ok: report.checks.filter((c) => c.status === "ok").length,
      degraded: report.checks.filter((c) => c.status === "degraded").length,
      missing: report.checks.filter((c) => c.status === "missing").length,
    });
    assert.equal(report.counts.ok + report.counts.degraded + report.counts.missing, CHECK_NAMES.length);

    // independent re-derivation of the verdict from the SAME primitives
    const manifestSpec = (
      JSON.parse(readFileSync(path.join(whisperToolkitRoot(), "package.json"), "utf8")) as {
        engines?: { node?: string };
      }
    ).engines?.node;
    const [ffmpegP, ffprobeP, sayP] = await Promise.all([
      binaryPath("ffmpeg"),
      binaryPath("ffprobe"),
      binaryPath("say"),
    ]);
    const [handyP, whisperP, whisperModelP, subtitles, drawtext, encs, font] = await Promise.all([
      findHandy(),
      findWhisperCli(),
      Promise.resolve(resolveWhisperModel()),
      hasFilter("subtitles"),
      hasFilter("drawtext"),
      listEncoders(),
      stat(OVERLAY_FONT_FILE).then(() => true, () => false),
    ]);
    const coreOk =
      ffmpegP !== null && ffprobeP !== null &&
      Number(process.versions.node.split(".")[0]) >= (nodeEnginesFloor(manifestSpec) ?? 0);
    const optionalBad =
      !subtitles || !drawtext ||
      encs.find((e) => e.codec === "h264" && !e.hardware) === undefined ||
      encs.find((e) => e.codec === "h264" && e.hardware) === undefined ||
      !font || handyP === null || whisperP === null || whisperModelP === null || sayP === null;
    const expected: DoctorReport["status"] = !coreOk ? "broken" : optionalBad ? "degraded" : "ok";

    assert.equal(report.status, expected);
    assert.equal(r.code, expected === "broken" ? 1 : 0, "exit 0 unless broken");
    assert.deepEqual(report.engines, { handy: handyP !== null, whisper: whisperP !== null && whisperModelP !== null });
    const by = (n: string) => report.checks.find((c) => c.name === n)!;
    assert.equal(by("filter-subtitles").status, subtitles ? "ok" : "missing");
    assert.equal(by("filter-drawtext").status, drawtext ? "ok" : "missing");
    assert.equal(by("overlay-font").status, font ? "ok" : "missing");
    assert.equal(by("engine-handy").status, handyP ? "ok" : "missing");
    assert.equal(by("engine-whisper").status, whisperP && whisperModelP ? "ok" : "missing");
    assert.equal(by("say").status, sayP ? "ok" : "missing");

    // CLI parity with the in-process engine call (byte-identical logic path)
    assert.deepEqual(report, await runDoctor());

    // the cache probe leaves nothing behind
    const probeLeft = await stat(path.join(".video-agent", ".doctor-probe")).then(() => true, () => false);
    assert.equal(probeLeft, false);
  } finally {
    process.chdir(prev);
    await rm(dir, { recursive: true, force: true });
  }
});

test("live CLI: doctor --pretty pretty-prints the same report", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "video-doctor-"));
  const prev = process.cwd();
  process.chdir(dir);
  try {
    const r = await run("doctor", "--pretty");
    assert.ok(r.stdout.trim().split("\n").length > 1, "--pretty is multi-line");
    const report = JSON.parse(r.stdout) as DoctorReport;
    assert.deepEqual(report.checks.map((c) => c.name), [...CHECK_NAMES]);
    assert.equal(r.code, report.status === "broken" ? 1 : 0);
    assert.deepEqual(report, await runDoctor());
  } finally {
    process.chdir(prev);
    await rm(dir, { recursive: true, force: true });
  }
});

// the toolkit-root cache detail names the real root (the same derivation the
// whisper model resolution uses) — locked so the check cannot drift
test("live: cache-toolkit-root check names the whisper toolkit root", async () => {
  const report = await runDoctor();
  const c = report.checks.find((x) => x.name === "cache-toolkit-root")!;
  assert.ok(c.detail.includes(whisperToolkitRoot()));
});

// the node check consumes the REAL manifest's engines spec (not a hardcode)
test("live: node check detail carries the manifest's engines.node spec", async () => {
  const pkg = JSON.parse(
    readFileSync(path.join(whisperToolkitRoot(), "package.json"), "utf8"),
  ) as { engines?: { node?: string } };
  const report = await runDoctor();
  const c = report.checks.find((x) => x.name === "node")!;
  assert.ok(c.detail.includes(pkg.engines?.node ?? "<none>"));
  assert.ok(c.detail.includes(process.versions.node));
});
