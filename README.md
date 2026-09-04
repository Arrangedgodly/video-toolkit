# video-toolkit

Agent-native video editing toolkit. Deterministic tools, a versioned edit-plan as the central artifact, and single-pass rendering — so AI agents never hand-write FFmpeg commands, parse raw ffprobe output, or reason about codecs.

> **For AI agents**: [`AGENTS.md`](./AGENTS.md) is the canonical, machine-first contract reference (commands, schemas, error codes, engine contracts, extension rules). This README is the human overview.

## Philosophy

**Tools first, agents second.** LLMs make editorial decisions (what to keep, whether a pause is dead air, what makes a good highlight). Deterministic software handles everything else: metadata, timestamps, command construction, cutting, encoding, validation, execution. No LLM is involved anywhere in this package.

## Prerequisites

- Node.js ≥ 20
- `ffmpeg` and `ffprobe` on PATH

## Install

```sh
git clone <this repo> && cd video-toolkit
npm install
npm run build
npm link          # puts `video` on PATH
```

## Commands

```
video inspect <input>      structured media metadata (JSON)
video plan <input>         scaffold a valid edit plan for the source
video validate <plan>      check a plan; machine-readable errors
video preview <plan>       cheap preview render (<output>.preview.mp4)
video render <plan>        final render from the validated plan
video diagnose             environment + ffmpeg capabilities (JSON)
video benchmark <input>    measure fastest encoder/concurrency on this machine
```

### Analysis workers (timestamped observations; never render)

```
video detect-silence <input>       silence gaps: {segments: [{start, end, duration}]}
video detect-scenes <input>        scene-cut boundaries: {boundaries: [{timestamp, confidence}]}
video transcribe <input>           timestamped transcript (Parakeet via Handy; windowed;
                                   --engine/--model/--chunk, --concurrency N parallel windows)
video detect-filler <t.json>       filler-word candidates from a transcript
video find-highlights <input>      highlight proposals (--transcript, --keywords)
video captions <t.json>            transcript → .srt or .vtt; --plan remaps cue times
                                   through cuts (--format srt|vtt to override)
video extract-frame <input>        jpg stills at --at t1,t2 / --count N (--size W to downscale)
video review-frames <input>        boundary-grouped review stills (--scenes s.json,
                                   --per-boundary N, --window s, --size W)
video generate-proxy <input>       low-cost review copy (default 480w, CRF 28)
```

**Captions**: burning is a plan operation — `{"type": "captions", "file": "subs.srt", "style": "FontSize=24"}` — rendered in the same single pass via libass. Cue times are interpreted against the **edited output timeline**, so source-timed transcripts go through `video captions transcript.json --plan plan.json`, which remaps cues through the compiled timeline (a cue spanning a cut splits; fragments under 0.3s drop). Output is SRT (default) or WebVTT: the format follows the `-o` extension (`.srt`/`.vtt`), or pass `--format srt|vtt` explicitly; cue math is identical across formats, WebVTT just serializes with a `WEBVTT` header, `.`-separated milliseconds, and HTML-escaped cue text.

**find-highlights** turns observations into deterministic proposals: each transcript segment is scored on speech rate, pause-before emphasis, keyword hits, and length band, with reasons attached — the agent makes the editorial call on what to keep.

Results are cached per (source fingerprint, parameters) under `.video-agent/cache/` — an unchanged source costs nothing on re-analysis. Workers never modify the source and never render edits; they only observe. A video without audio yields an empty silence/transcript report with a `note`, not an error.

**Transcription engines**: the engine boundary (`src/analysis/transcribe/engines.ts`) takes any backend that turns a 16 kHz mono WAV into text. Implemented: **handy** (`/Applications/Handy.app`, Parakeet TDT 0.6B v3 on Metal, 5–21× realtime measured). Handy emits whole-file text without timestamps, so the worker windows the audio (default 25 s chunks, boundaries snapped to nearby silence) — segment times are exact by construction, text granularity is the window. Windows can run in parallel: `--concurrency N` (default 1, or the cached `video benchmark` recommendation for the source) bounds how many WAV extractions + independent engine processes run at once; output stays byte-identical to sequential because results are reassembled in window order. Swap in whisper.cpp/sherpa by implementing one interface.

The **observation → plan bridges**: `video plan <input> --cuts-from silence.json [--min-duration 0.5] [--pad 0.25]` expands qualifying silence gaps into explicit `cut` operations in the scaffolded plan. `video plan <input> --cuts-from filler.json [--filler-pad-before 0.10] [--filler-pad-end 0.25]` expands filler-word instances into `cut` operations — the report shape (silence vs filler) is discriminated automatically, and the filler pads expand beyond the estimate because filler times are linear estimates within segment granularity. `video plan <input> --highlights-from highlights.json [--count 5] [--min-score 0.35] [--pad 0.5]` scaffolds a highlight **compilation** — the top candidates by score become `trim` operations that replace the whole-source keep (overlapping trims union; a report with no qualifying candidate leaves the whole-source scaffold; one bridge per invocation). The expansions are deterministic; the editorial decisions live in the parameters and in whatever you delete or tune afterwards.

Global flags: `--pretty` (human-readable JSON), `--debug` (commands, stage timings, cache hits), `--no-cache`. Render flags: `--force`, `--encoder libx264|h264_videotoolbox`, `--mode final|preview`.

## The edit plan

The plan is a declaration of **what to keep**, not a script: `trim` keeps a range, `cut` removes a range, and order never matters. Multiple trims are the "concatenate the remaining segments" case — the timeline compiler flattens everything into keep-segments and renders in **one FFmpeg pass**.

```json
{
  "version": 1,
  "source": "input.mp4",
  "operations": [
    { "type": "trim", "start": 3.2, "end": 120.5 },
    { "type": "cut", "start": 24.1, "end": 27.8 },
    { "type": "normalize-audio", "target": -16 },
    { "type": "speed", "factor": 1.25 },
    { "type": "resize", "width": 1280 },
    { "type": "volume", "db": -3 },
    { "type": "audio-mix", "file": "bed.mp3", "level": -18,
      "duck": { "threshold": 0.02, "ratio": 8, "attack": 20, "release": 400 } }
  ],
  "output": { "path": "output.mp4", "mode": "final" }
]
```

Timeline ops (`trim`, `cut`) decide **which source ranges are kept**. Transform ops (`speed`, `resize`, `volume`, `normalize-audio`, `audio-mix`) apply to the whole output — at most one of each per plan — and compose into the same single render pass (audio follows speed via a clamped `atempo` chain; `volume` takes `db` or `factor`, exactly one). `audio-mix` layers a music bed under the program with speech-keyed sidechain ducking: the bed loops and trims to the timeline, `level` is bed gain in dB (default −18), and `duck` tunes the compressor — note `threshold` is **linear** amplitude (default 0.02 ≈ −34 dB), while `attack`/`release` are milliseconds (defaults 20/400).

Schemas are Zod discriminated unions (`src/core/schemas.ts`); adding an operation type means one schema case plus one compiler/validator entry — the execution engine does not change. Timestamps are seconds, everywhere, in every layer.

## Workflow

```
video inspect src.mp4            → facts
video plan src.mp4 > plan.json   → scaffold; edit the operations
video validate plan.json         → machine-readable errors until valid
video preview plan.json          → <output>.preview.mp4 (640w, ultrafast, CRF 30)
  … iterate on the plan; previews never touch the final path …
video render plan.json           → ONE final pass (CRF 18, medium, AAC 192k)
```

Previews write `<output>.preview.mp4` so they can never clobber the final. The source is read directly in every render — no intermediate encodes, ever.

## Validation

`video validate` returns `{valid, errors, warnings, timelineDuration}`. Errors carry a stable code and a 1-based operation index:

```json
{"valid":false,"errors":[{"code":"TIMESTAMP_OUT_OF_RANGE","operation":1,"message":"trim: range [0, 100] exceeds source duration 12.000s"}],"warnings":[],"timelineDuration":8}
```

Codes: `PLAN_INVALID_JSON`, `PLAN_SCHEMA_INVALID`, `SOURCE_NOT_FOUND`, `TIMESTAMP_OUT_OF_RANGE`, `RANGE_NEGATIVE`, `EMPTY_TIMELINE`, `OUTPUT_PATH_INVALID`, `OUTPUT_WOULD_OVERWRITE_SOURCE`, `OUTPUT_EXISTS`, `MIX_INPUT_NOT_FOUND`, `FFMPEG_FAILED`, `FFMPEG_NOT_FOUND`, `FFPROBE_NOT_FOUND`, `UNSUPPORTED_MEDIA`. Render refuses to overwrite outputs without `--force` and can never overwrite the source.

## MCP server

The same engine is exposed as an MCP stdio server — every command becomes a `video_*` tool (`video_inspect`, `video_plan`, `video_validate`, `video_preview`, `video_render`, `video_detect_silence`, `video_detect_scenes`, `video_review_frames`, `video_extract_frames`, `video_generate_proxy`, `video_diagnose`, `video_benchmark`). The server is a thin adapter over the engine functions the CLI uses; the engine has no knowledge of MCP or any AI provider.

```sh
video mcp        # or: video-mcp
```

Client config (ZCode/Claude-style):

```json
{
  "mcpServers": {
    "video": { "command": "video-mcp" }
  }
}
```

Tool results are the same compact JSON the CLI emits, wrapped as MCP text content; failures arrive as `isError` results carrying the same `{error: {code, message}}` objects, so error branching is identical across CLI and MCP.

## Architecture

```
CLI (src/cli)                    thin dispatch, compact JSON out
agent/ (src/agent)               MCP stdio adapter — same engine functions
  ↓
core/schemas                     Zod: edit plan + observation schemas
  ↓
validate/                        plan + media facts → ValidationReport
  ↓
core/timeline                    ops → keep-segments (pure math, fully tested)
  ↓
media/ffmpeg                     command builder (argv arrays only) + runner
  ↓                                 (progress parsing, error normalization)
render/                          preview/final settings, single-pass render
analysis/                        workers: silence, scenes, frames, proxy
hardware/                        diagnose: encoders/hwaccels discovered, not assumed
benchmark/                       measured encoder × concurrency matrix
cache/                           .video-agent/cache/<source-id>/ (path+size+mtime)
```

FFmpeg command construction lives in exactly one module; the CLI never sees a command string. `--debug` prints every generated command plus per-stage timings.

## How an agent should consume this

1. `video inspect <input>` for facts — never parse ffprobe yourself.
2. Observe: run the analyses the task needs (`detect-silence`, `detect-scenes`); use `extract-frame` to actually look at moments, `review-frames --scenes scenes.json` for grouped stills around every scene boundary (the review unit for scene judgments), `generate-proxy` for a review copy. Observations are cached — re-running is free.
3. Decide: turn observations into editorial choices. `video plan <input> --cuts-from silence.json` pre-fills silence cuts deterministically; `video plan <input> --cuts-from filler.json` pre-fills filler cuts from a `detect-filler` report (verify the estimated times with `extract-frame --at` first); `video plan <input> --highlights-from highlights.json` scaffolds a best-moments compilation from a `find-highlights` report. Keep, drop, or tune the proposed ops by judgment.
4. `video validate` until `valid: true`; branch on `code` to fix errors programmatically.
5. `video preview` to check the edit visually; iterate on the plan.
6. `video render` once, when the plan is approved.
7. `video diagnose` / `video benchmark <input>` answer environment questions (hardware encoders, fastest strategy) so you don't guess.

Default output is compact single-line JSON (token-efficient); add `--pretty` only for humans.

## Analysis workers

Implemented: silence (`silencedetect`), scenes (`select=gt(scene,T)` + `metadata=print`), frame extraction, proxy generation. Each worker follows the same shape — `src/analysis/runner.ts` provides the shared skeleton: read cached media facts, compute, Zod-validate the report, cache by source fingerprint + parameters. Adding a worker is one module plus one CLI case; the schemas it must satisfy (`SilenceReport`, `SceneReport`, `TranscriptReport`) live in `core/schemas.ts`.

Not yet implemented: `transcribe` (needs an external engine — the engine boundary is designed for swapping: the worker produces `TranscriptReport` regardless of whether whisper.cpp or a cloud API feeds it), `detect-filler`, `find-highlights` (these are editorial *proposals* built on top of observations, not raw observations).

Workers never render; they only observe. The plan remains the single interface between judgment and execution, so providers, transcription engines, encoders, and agent frameworks can all be swapped without touching it.

## Development

```sh
npm run typecheck
npm test          # unit (schemas, timeline) + integration (real renders on a generated fixture)
```

The integration suite generates a 12s fixture with ffmpeg at test time — no video files are committed.

## Relationship to vedit

`vedit` (same workspace) is an imperative quick-edit CLI; this toolkit is the plan-based engine. The single-pass multi-range select recipe, silence-gap parsing, and timeline semantics were ported from vedit's tested implementation.
