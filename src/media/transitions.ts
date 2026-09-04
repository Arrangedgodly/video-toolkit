import { fail } from "../core/errors.js";
import { CROSSFADE_KINDS } from "../core/schemas.js";
import { Cache, type CacheOpts } from "../cache/cache.js";
import { ffmpegVersion } from "./ffmpeg.js";
import { runCapture } from "./ffprobe.js";

/** `video transitions` (T13) — the xfade transition enum, parsed
 * DETERMINISTICALLY from this build's live `ffmpeg -h filter=xfade` output.
 * Ground truth, never a hand-maintained list: the plan schema's
 * `CROSSFADE_KINDS` allowlist (T17) EQUALS this catalog on the pinned build
 * (equality is enforced at test time in both directions; at runtime the
 * MISSING direction stays a hard failure below, the extras direction stays
 * non-fatal so discovery keeps working across ffmpeg upgrades). Pure
 * environment query: no rendering, writes nothing but its cache. */

export interface TransitionsReport {
  /** one entry per kind, in the order ffmpeg's help lists them (stable for
   * a pinned build) — the discovery surface for `crossfade.kind` */
  transitions: { kind: string }[];
  count: number;
  /** ffmpeg build the catalog was parsed from (also the cache key) */
  ffmpeg: string;
  /** present ONLY when this build lists kinds beyond the schema allowlist
   * (an ffmpeg upgrade): discovery still works, but `crossfade.kind` accepts
   * the allowlist only until it is re-verified and re-derived (T17 sweep) */
  note?: string;
}

/** The AVOptions line that opens the transition enum block:
 *  `   transition        <int>        ..FV....... set cross fade transition (from -1 to 57) (default fade)` */
const TRANSITION_OPTION_RE = /^ {3}transition\s+<int>/;

/** One enum entry line (5-space indent, integer value):
 *  `     fade            0            ..FV....... fade transition` */
const ENUM_ENTRY_RE = /^ {5}(\S+)\s+(-?\d+)\s/;

/** Parse the xfade transition enum from `ffmpeg -h filter=xfade` text.
 * Pure function of the text; entries keep the help's listing order; enum
 * values < 0 are sentinels (the `custom` placeholder needs `expr=` and is
 * not a standalone transition) and are excluded. Absent/garbled help
 * (filter missing, format drift) → FILTER_HELP_UNPARSEABLE. */
export function parseXfadeTransitions(helpText: string): string[] {
  const lines = helpText.split("\n");
  const start = lines.findIndex((l) => TRANSITION_OPTION_RE.test(l));
  if (start === -1) {
    fail(
      "FILTER_HELP_UNPARSEABLE",
      "`ffmpeg -h filter=xfade` output has no transition option — the xfade filter is absent from this build or the help format changed",
    );
  }
  const kinds: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const m = ENUM_ENTRY_RE.exec(lines[i]!);
    if (!m) break; // the enum block ended (next option, blank line, EOF)
    if (Number(m[2]) >= 0) kinds.push(m[1]!);
  }
  if (kinds.length === 0) {
    fail(
      "FILTER_HELP_UNPARSEABLE",
      "`ffmpeg -h filter=xfade` has a transition option but no parsable enum entries (help format changed?)",
    );
  }
  return kinds;
}

/** The catalog must carry EVERY allowlisted kind (T17 equality era: the
 * allowlist == the committed generated list, and the test suite cross-checks
 * it against the committed fixture AND a live re-parse in both directions).
 * A live or cache-cached catalog that LACKS an allowlisted kind is a real
 * regression: surface it loudly instead of emitting a quietly narrowed
 * catalog. Runs on cache hits too — a stale or hand-edited cache file must
 * never mask it. The EXTRAS direction (an upgraded build listing kinds
 * beyond the allowlist) is deliberately NOT an error — see
 * extrasBeyondAllowlist. */
export function assertCatalogCoversAllowlist(kinds: string[], ffmpeg: string): void {
  const have = new Set(kinds);
  const missing = CROSSFADE_KINDS.filter((k) => !have.has(k));
  if (missing.length > 0) {
    fail(
      "FILTER_HELP_UNPARSEABLE",
      `ffmpeg ${ffmpeg} xfade enum is missing allowlisted crossfade kind(s): ${missing.join(", ")} — build regression; re-derive the schema allowlist rather than trusting this catalog`,
      { missing: [...missing] },
    );
  }
}

/** Kinds this build lists BEYOND the schema allowlist (an ffmpeg upgrade):
 * NOT a failure — the catalog's discovery role must survive upgrades.
 * Surfaced as a report note (in-task decision, T17); the extras stay
 * unaccepted for `crossfade.kind` until the allowlist is re-verified and
 * re-derived. Pure function. */
export function extrasBeyondAllowlist(kinds: string[]): string[] {
  const have = new Set<string>(CROSSFADE_KINDS);
  return kinds.filter((k) => !have.has(k));
}

/** Attach the drift note when (and only when) the catalog outruns the
 * allowlist; never persisted to the cache — recomputed from the kinds on
 * every return, so a widened allowlist changes the note without a cache
 * flush. */
function withDriftNote(report: TransitionsReport): TransitionsReport {
  const extras = extrasBeyondAllowlist(report.transitions.map((t) => t.kind));
  if (extras.length === 0) return report;
  return {
    ...report,
    note:
      `ffmpeg ${report.ffmpeg} lists ${extras.length} xfade kind(s) beyond the crossfade allowlist ` +
      `(${extras.join(", ")}) — unverified for crossfade.kind; the allowlist re-derives only through parametrized re-verification`,
  };
}

/** Cache id for environment-keyed caches (benchmark keys by source; this
 * catalog has no source to fingerprint, only the ffmpeg build). */
const ENV_CACHE_ID = "env";

/** Cache name keyed by ffmpeg version — the filter enum is build-dependent,
 * mirroring benchmark's version-keyed precedent so an upgrade re-parses. */
export function transitionsCacheName(ffmpeg: string): string {
  return `transitions-${ffmpeg}.json`;
}

export async function catalogTransitions(opts: CacheOpts = {}): Promise<TransitionsReport> {
  const debug = opts.debug ?? (() => {});
  const ffmpeg = await ffmpegVersion("ffmpeg");
  const name = transitionsCacheName(ffmpeg);
  const cache = new Cache();
  if (!opts.noCache) {
    const hit = await cache.read<TransitionsReport>(ENV_CACHE_ID, name);
    if (hit) {
      debug(`cache hit: ${name}`);
      assertCatalogCoversAllowlist(
        hit.transitions.map((t) => t.kind),
        hit.ffmpeg,
      );
      return withDriftNote(hit);
    }
    debug(`cache miss: ${name}`);
  }

  const r = await runCapture("ffmpeg", ["-hide_banner", "-h", "filter=xfade"]);
  if (r.code === -1 && r.stderr.startsWith("ENOENT")) {
    fail("FFMPEG_NOT_FOUND", "ffmpeg binary not found on PATH");
  }
  if (r.code !== 0) {
    fail("FFMPEG_FAILED", "ffmpeg -h filter=xfade failed", {
      command: `ffmpeg -hide_banner -h filter=xfade`,
      stderrTail: r.stderr.trim().split("\n").slice(-15).join("\n"),
    });
  }
  // note: a build WITHOUT the filter exits 0 with an "Unknown filter" notice
  // on stderr and empty stdout — the parse itself must catch that
  const kinds = parseXfadeTransitions(r.stdout);
  assertCatalogCoversAllowlist(kinds, ffmpeg);
  const report: TransitionsReport = {
    transitions: kinds.map((kind) => ({ kind })),
    count: kinds.length,
    ffmpeg,
  };
  // the raw report is cached; the drift note rides on the returned value
  if (!opts.noCache) await cache.write(ENV_CACHE_ID, name, report);
  return withDriftNote(report);
}
