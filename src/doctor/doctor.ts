import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  binaryPath,
  ffmpegVersion,
  hasFilter,
  listEncoders,
  OVERLAY_FONT_FILE,
  type EncoderEntry,
} from "../media/ffmpeg.js";
import { findHandy } from "../analysis/transcribe/handy.js";
import {
  findWhisperCli,
  resolveWhisperModel,
  whisperModelsDirs,
  whisperToolkitRoot,
  WHISPER_DEFAULT_MODEL,
} from "../analysis/transcribe/whisper.js";

/**
 * `video doctor` (T29) — ONE deterministic, machine-readable diagnosis of
 * every environmental dependency, assembled from the EXISTING tested probe
 * machinery (binaryPath/ffmpegVersion/hasFilter/listEncoders, findHandy,
 * whisper's exported model-resolution helpers — no ad-hoc re-probes).
 * Read-only by design with ONE documented write: the cache-health probe
 * touches and removes a file under `.video-agent/` (the cache's own root).
 *
 * Aggregation law (pure, unit-tested):
 *   broken   = a CORE check (node, ffmpeg, ffprobe) is not ok — the toolkit
 *              cannot run: core binaries missing or node below engines
 *   degraded = any optional check not ok (missing capability)
 *   ok       = every check ok
 * Exit 0 unless broken (exit 1) — the CLI's contract; MCP carries the report
 * as a normal payload (broken is a REPORT, never an isError).
 */

export type CheckStatus = "ok" | "missing" | "degraded";
export type DoctorStatus = "ok" | "degraded" | "broken";

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
  impact?: string;
  remediation?: string;
}

/** Internal aggregation weight: a non-ok CORE check ⇒ broken. Never emitted. */
export interface AggregatableCheck extends DoctorCheck {
  core: boolean;
}

export interface DoctorEngines {
  handy: boolean;
  whisper: boolean;
}

export interface DoctorCounts {
  ok: number;
  degraded: number;
  missing: number;
}

export interface DoctorReport {
  status: DoctorStatus;
  checks: DoctorCheck[];
  engines: DoctorEngines;
  counts: DoctorCounts;
}

/** The cache-health probe filename inside `.video-agent/` (fixed — the
 * report is deterministic; the file is removed immediately). */
export const DOCTOR_CACHE_PROBE_FILE = ".doctor-probe";

/** Major-version floor from an engines.node spec (the repo's own is
 * ">=20"). Degrades to the first integer when the comparator drifts
 * ("^20.1.0" → 20); null when no integer exists (unconstrained). Pure. */
export function nodeEnginesFloor(spec: string | undefined): number | null {
  if (!spec) return null;
  const m = />=\s*(\d+)/.exec(spec) ?? /(\d+)/.exec(spec);
  return m ? Number(m[1]) : null;
}

/** Pure status aggregation over a check set — the report's ONLY verdict
 * logic. broken beats degraded beats ok; counts are exact tallies. */
export function aggregateDoctorChecks(checks: AggregatableCheck[]): {
  status: DoctorStatus;
  counts: DoctorCounts;
} {
  const counts: DoctorCounts = { ok: 0, degraded: 0, missing: 0 };
  for (const c of checks) counts[c.status] += 1;
  const coreBroken = checks.some((c) => c.core && c.status !== "ok");
  const status: DoctorStatus = coreBroken
    ? "broken"
    : counts.degraded + counts.missing > 0
      ? "degraded"
      : "ok";
  return { status, counts };
}

/** Every probe the doctor consumes, injectable for tests (the broken-path
 * units run against fake sets — no environment mutation needed). The default
 * set is the existing machinery verbatim. */
export interface DoctorProbes {
  nodeVersion(): string;
  enginesNodeSpec(): string | undefined;
  resolveBinary(name: string): Promise<string | null>;
  ffmpegVersion(binary: "ffmpeg" | "ffprobe"): Promise<string>;
  encoders(): Promise<EncoderEntry[]>;
  filterPresent(name: string): Promise<boolean>;
  filePresent(file: string): Promise<boolean>;
  findHandy(): Promise<string | null>;
  findWhisperCli(): Promise<string | null>;
  resolveWhisperModel(): string | null;
  /** sorted *.bin names in one models dir; [] when the dir is absent/empty */
  listModelBins(dir: string): string[];
  dirWritable(dir: string): Promise<boolean>;
}

function enginesSpecFromManifest(): string | undefined {
  try {
    const pkg = readFileSync(path.join(whisperToolkitRoot(), "package.json"), "utf8");
    const engines = (JSON.parse(pkg) as { engines?: { node?: string } }).engines;
    return engines?.node;
  } catch {
    return undefined; // no manifest insight — treat as unconstrained
  }
}

async function probeDirWritable(dir: string): Promise<boolean> {
  try {
    await mkdir(dir, { recursive: true });
    const probe = path.join(dir, DOCTOR_CACHE_PROBE_FILE);
    await writeFile(probe, "");
    await rm(probe);
    return true;
  } catch {
    return false;
  }
}

export const defaultDoctorProbes: DoctorProbes = {
  nodeVersion: () => process.versions.node,
  enginesNodeSpec: enginesSpecFromManifest,
  resolveBinary: binaryPath,
  ffmpegVersion,
  encoders: listEncoders,
  filterPresent: hasFilter,
  filePresent: async (file) => {
    try {
      await stat(file);
      return true;
    } catch {
      return false;
    }
  },
  findHandy,
  findWhisperCli,
  resolveWhisperModel: () => resolveWhisperModel(),
  listModelBins: (dir) => {
    try {
      return readdirSync(dir)
        .filter((f) => f.endsWith(".bin"))
        .sort();
    } catch {
      return [];
    }
  },
  dirWritable: probeDirWritable,
};

/** Sorted `*.bin` listing across BOTH whisper models dirs (cwd convention +
 * toolkit root — the same helpers `transcribe` resolves through), prefixed by
 * their dir like `details.known` does. Empty-string when nothing is found. */
function whisperModelsListing(
  probes: DoctorProbes,
  dirs: string[],
): string {
  const parts: string[] = [];
  for (const d of dirs) {
    const bins = probes.listModelBins(d);
    parts.push(`${d}: ${bins.length > 0 ? bins.join(", ") : "no .bin models"}`);
  }
  return parts.join("; ");
}

/** Run the full diagnosis. Deterministic: fixed check order, no timing, no
 * randomness; every probe is either a stat/argv spawn or a fs touch+remove. */
export async function runDoctor(probes: DoctorProbes = defaultDoctorProbes): Promise<DoctorReport> {
  const checks: AggregatableCheck[] = [];

  // 1. node vs engines (CORE)
  {
    const nodeVer = probes.nodeVersion();
    const spec = probes.enginesNodeSpec();
    const floor = nodeEnginesFloor(spec);
    const major = Number(nodeVer.split(".")[0]);
    if (floor === null) {
      checks.push({
        core: true,
        name: "node",
        status: "ok",
        detail: `node v${nodeVer} (engines.node spec '${spec ?? "absent"}' parsed as unconstrained)`,
      });
    } else if (Number.isFinite(major) && major >= floor) {
      checks.push({
        core: true,
        name: "node",
        status: "ok",
        detail: `node v${nodeVer} satisfies engines.node '${spec}' (>= ${floor})`,
      });
    } else {
      checks.push({
        core: true,
        name: "node",
        status: "missing",
        detail: `node v${nodeVer} is below engines.node '${spec}' (needs >= ${floor})`,
        impact: "every command — the toolkit does not run on this node",
        remediation: `install node >= ${floor} (engines.node) and re-run`,
      });
    }
  }

  // 2–3. ffmpeg + ffprobe presence + versions (CORE)
  const [ffmpegPath, ffprobePath] = await Promise.all([
    probes.resolveBinary("ffmpeg"),
    probes.resolveBinary("ffprobe"),
  ]);
  for (const [name, bin] of [
    ["ffmpeg", ffmpegPath],
    ["ffprobe", ffprobePath],
  ] as const) {
    if (bin === null) {
      checks.push({
        core: true,
        name,
        status: "missing",
        detail: `${name} not found on PATH`,
        impact: "every command — renders, previews, and analysis workers all spawn it",
        remediation: `install ${name} (e.g. brew install ffmpeg) and ensure it is on PATH`,
      });
    } else {
      const version = await probes.ffmpegVersion(name);
      checks.push({
        core: true,
        name,
        status: "ok",
        detail: `${name} ${version} at ${bin}`,
      });
    }
  }

  // 4. ffmpeg capability filters (the existing hasFilter cache)
  for (const [filter, op] of [
    ["subtitles", "captions"],
    ["drawtext", "overlay-text"],
  ] as const) {
    const present = await probes.filterPresent(filter);
    if (present) {
      checks.push({
        core: false,
        name: `filter-${filter}`,
        status: "ok",
        detail: `ffmpeg '${filter}' filter present (${filter === "subtitles" ? "libass" : "freetype"} build)`,
      });
    } else {
      checks.push({
        core: false,
        name: `filter-${filter}`,
        status: "missing",
        detail: `ffmpeg built without the '${filter}' filter (${filter === "subtitles" ? "libass" : "freetype"} absent)`,
        impact: `plan op \`${op}\` — the render graph needs '${filter}'; validate/build fails on plans carrying it`,
        remediation: "install an ffmpeg build with the filter (macOS brew: `brew unlink ffmpeg && brew link --force ffmpeg-full`)",
      });
    }
  }

  // 5. encoders incl. hardware (the existing listEncoders)
  {
    const encs = await probes.encoders();
    const sw = encs.find((e) => e.codec === "h264" && !e.hardware)?.name ?? null;
    const hw = encs.find((e) => e.codec === "h264" && e.hardware)?.name ?? null;
    const hwFamilies = [...new Set(encs.filter((e) => e.hardware).map((e) => e.name))];
    const families =
      hwFamilies.length > 0 ? hwFamilies.join(", ") : "none (software-only build)";
    if (sw !== null && hw !== null) {
      checks.push({
        core: false,
        name: "encoders",
        status: "ok",
        detail: `h264: ${sw} (software) + ${hw} (hardware); hardware encoders: ${families}`,
      });
    } else if (sw !== null) {
      checks.push({
        core: false,
        name: "encoders",
        status: "degraded",
        detail: `h264 software encoder ${sw} present; no hardware h264 encoder (hardware encoders: ${families})`,
        impact: "`render --encoder h264_videotoolbox` and `benchmark`'s hardware measurements — the software path (`libx264`, the default) is unaffected",
        remediation: "hardware encoders are build/platform-specific (videotoolbox on darwin, nvenc/qsv/amf elsewhere); libx264 remains fully functional",
      });
    } else {
      checks.push({
        core: false,
        name: "encoders",
        status: "missing",
        detail: `no software h264 encoder (libx264 absent; hardware encoders: ${families})`,
        impact: "`render`/`preview` default software path (`libx264`) and the `--encoder libx264` flag",
        remediation: "install an ffmpeg build with libx264 (any standard distribution carries it)",
      });
    }
  }

  // 6. overlay font (the op's ONE fixed font rule)
  {
    const present = await probes.filePresent(OVERLAY_FONT_FILE);
    if (present) {
      checks.push({
        core: false,
        name: "overlay-font",
        status: "ok",
        detail: `overlay-text font ${OVERLAY_FONT_FILE} present`,
      });
    } else {
      checks.push({
        core: false,
        name: "overlay-font",
        status: "missing",
        detail: `overlay-text font ${OVERLAY_FONT_FILE} missing (a macOS system path)`,
        impact: "plan op `overlay-text` — validate rejects plans with OPERATION_INVALID naming the font (correct-by-error by design; the engine never guesses a fallback font)",
        remediation: "run on macOS for overlay-text, or use the `captions` op / `image-overlay` op instead",
      });
    }
  }

  // 7–8. transcription engines (the engines' own exported probes)
  const [handyBin, whisperBin] = await Promise.all([
    probes.findHandy(),
    probes.findWhisperCli(),
  ]);
  const whisperModel = probes.resolveWhisperModel();
  if (handyBin !== null) {
    checks.push({
      core: false,
      name: "engine-handy",
      status: "ok",
      detail: `Handy at ${handyBin}`,
    });
  } else {
    checks.push({
      core: false,
      name: "engine-handy",
      status: "missing",
      detail: "Handy.app not found in /Applications or ~/Applications",
      impact: "`transcribe --engine handy` and the default engine priority (whisper-cpp takes over when available)",
      remediation: "install Handy.app, or transcribe with `--engine whisper-cpp`",
    });
  }
  {
    const model = whisperModel;
    const listing = whisperModelsListing(probes, whisperModelsDirs());
    if (whisperBin !== null && model !== null) {
      checks.push({
        core: false,
        name: "engine-whisper",
        status: "ok",
        detail: `whisper-cli at ${whisperBin}; model ${model} (${listing})`,
      });
    } else if (whisperBin !== null) {
      checks.push({
        core: false,
        name: "engine-whisper",
        status: "missing",
        detail: `whisper-cli at ${whisperBin} but no model resolvable (default ${WHISPER_DEFAULT_MODEL}; ${listing})`,
        impact: "`transcribe --engine whisper-cpp` and `--word-timestamps` (word-precise filler anchors)",
        remediation: `place ${WHISPER_DEFAULT_MODEL} (or any ggml *.bin) in .video-agent/models/ under the cwd or the toolkit root — whisper-cli does NO name magic and NO download`,
      });
    } else {
      checks.push({
        core: false,
        name: "engine-whisper",
        status: "missing",
        detail: `whisper-cli not found on PATH (${listing})`,
        impact: "`transcribe --engine whisper-cpp` and `--word-timestamps` (word-precise filler anchors)",
        remediation: "install whisper-cpp and put whisper-cli on PATH (model resolution then follows .video-agent/models/)",
      });
    }
  }

  // 9. `say` (darwin speech fixtures — informational)
  {
    const say = await probes.resolveBinary("say");
    if (say !== null) {
      checks.push({
        core: false,
        name: "say",
        status: "ok",
        detail: "`say` on PATH (darwin speech fixtures)",
      });
    } else {
      checks.push({
        core: false,
        name: "say",
        status: "missing",
        detail: "`say` not found on PATH",
        impact: "informational — realistic speech fixtures for tests/examples only (the lavfi fallback works everywhere); no toolkit command requires it",
        remediation: "none needed outside darwin fixture generation",
      });
    }
  }

  // 10. cache health: cwd + toolkit-root .video-agent writable (touch + remove)
  const cwdCache = path.join(".video-agent");
  const rootCache = path.join(whisperToolkitRoot(), ".video-agent");
  for (const [name, dir] of [
    ["cache-cwd", cwdCache],
    ["cache-toolkit-root", rootCache],
  ] as const) {
    const writable = await probes.dirWritable(dir);
    if (writable) {
      checks.push({
        core: false,
        name,
        status: "ok",
        detail: `${dir} writable (probe touched and removed)`,
      });
    } else {
      checks.push({
        core: false,
        name,
        status: "degraded",
        detail: `${dir} not writable`,
        impact: "observation/metadata caching fails at write time (inspect/detect-*/transcribe/benchmark)",
        remediation: `ensure ${dir} (or its parent) is writable, or run from a writable directory`,
      });
    }
  }

  const { status, counts } = aggregateDoctorChecks(checks);
  const publicChecks: DoctorCheck[] = checks.map(({ core: _core, ...rest }) => rest);
  return {
    status,
    checks: publicChecks,
    engines: {
      handy: handyBin !== null,
      whisper: whisperBin !== null && whisperModel !== null,
    },
    counts,
  };
}
