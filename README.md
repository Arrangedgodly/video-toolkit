# video-toolkit

Agent-native video editing toolkit: deterministic tools, a versioned **edit plan** as the single artifact between judgment and execution, and **one-pass FFmpeg rendering** — so humans and AI agents never hand-write FFmpeg commands, parse raw ffprobe output, or reason about codecs.

> [!NOTE]
> **For AI agents:** [`AGENTS.md`](./AGENTS.md) is the canonical, machine-first contract reference — commands, schemas, error codes, engine contracts, extension rules. This README is the human-facing overview; when the two ever disagree, AGENTS.md wins.

## Why it exists

Editing video with an agent (or a shell) usually means stringing together FFmpeg incantations and hoping. This toolkit splits the work cleanly: **LLMs and humans make editorial decisions** (what to keep, whether a pause is dead air, what makes a good highlight); **deterministic software handles everything else** — metadata, timestamps, command construction, validation, encoding. No LLM runs inside this package. Workers observe, bridges propose, and the plan is the only path to a render, so transcription engines, encoders, and agent frameworks can all be swapped without touching the editing model. (The single-pass multi-range FFmpeg recipe and timeline semantics were ported from the tested `vedit` CLI in the same workspace.)

## Prerequisites

- Node.js ≥ 20
- `ffmpeg` and `ffprobe` on `PATH` — burned captions additionally require a build with **libass** (e.g. Homebrew's `ffmpeg-full`); `video diagnose` reports what your build supports
- Optional: Handy.app on macOS for on-device transcription (see [engines](./AGENTS.md#engines-transcription)) — without an engine, `transcribe` fails with the machine-readable `TRANSCRIPTION_ENGINE_UNAVAILABLE` instead of guessing

## Quickstart

From a checkout of this repository:

```sh
npm install
npm run build
npm link        # puts `video` and `video-mcp` on PATH
```

Then, on any video:

```sh
video inspect input.mp4        # facts: duration, codecs, streams (JSON)
video plan input.mp4 > plan.json
video validate plan.json       # {valid: true, ...}
video preview plan.json        # cheap render to <output>.preview.mp4
video render plan.json         # the final, single-pass render
```

Default output is compact single-line JSON (token-efficient); add `--pretty` for humans. Global flags: `--pretty`, `--debug` (generated commands, stage timings, cache hits), `--no-cache`.

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
video detect-silence <input>       silence gaps
video detect-scenes <input>        scene-cut boundaries
video transcribe <input>           timestamped transcript (--concurrency N = parallel windows)
video detect-filler <t.json>       filler-word candidates from a transcript
video find-highlights <input>      highlight proposals (--transcript, --keywords)
video captions <t.json>            transcript → .srt or .vtt; --plan remaps cue times through cuts
video extract-frame <input>        jpg stills at --at t1,t2 / --count N
video review-frames <input>        stills grouped around every scene boundary (--scenes s.json)
video generate-proxy <input>       low-cost review copy (default 480w, CRF 28)
```

- **Observations are cached** per (source fingerprint, parameters) under `.video-agent/cache/` — an unchanged source costs nothing on re-analysis. Workers never modify the source and never render; a video without audio yields an empty report with a `note`, not an error.
- **Transcription** runs on swappable engines behind one interface. Implemented: **handy** (Parakeet models on Apple Silicon), which emits whole-file text without timestamps — so the worker windows the audio (default 25 s chunks, boundaries snapped to nearby silence; times exact by construction) and can run windows in parallel (`--concurrency N`, byte-identical output to sequential).
- **find-highlights** scores transcript segments (speech rate, pause-before emphasis, keyword hits, length band) into deterministic proposals with reasons attached — the agent makes the editorial call.
- **Captions** come in two pieces: `video captions transcript.json --plan plan.json -o out.srt` remaps source-timed cues onto the edited output timeline (a cue spanning a cut splits; fragments under 0.3 s drop), and burning them is a plan operation rendered in the same single pass. Output format follows the `-o` extension (`.srt` default or `.vtt` for WebVTT), with `--format srt|vtt` as explicit override.

### Observation → plan bridges

`video plan` can pre-fill ops from a report — deterministic expansion, editorially inert:

```sh
video plan input.mp4 --cuts-from silence.json [--min-duration 0.5] [--pad 0.25]
video plan input.mp4 --cuts-from filler.json  [--filler-pad-before 0.10] [--filler-pad-end 0.25]
video plan input.mp4 --highlights-from highlights.json [--count 5] [--min-score 0.35] [--pad 0.5]
```

Silence gaps and filler instances become `cut` ops (filler times are linear estimates — verify with `extract-frame --at` before rendering); highlight candidates become a `trim`-compilation replacing the whole-source keep. One bridge per invocation. The parameters are the editorial decisions; whatever you delete or tune afterwards is judgment.

## The edit plan

The plan declares **what to keep**, not a script: `trim` keeps a range, `cut` removes a range, and op order never matters. The timeline compiler flattens everything into keep-segments and renders in **one FFmpeg pass** — no intermediate encodes, ever.

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
}
```

**Timeline ops** (`trim`, `cut`) select source ranges; multiple `trim`s union. **Transform ops** (`speed`, `resize`, `volume`, `normalize-audio`, `audio-mix`) apply to the whole output — at most one of each per plan — and compose into the same single pass (audio follows `speed` via an `atempo` chain; `volume` takes `db` or `factor`, exactly one). `audio-mix` layers a looping music bed under the program audio with speech-keyed sidechain ducking: `level` is bed gain in dB, and inside `duck` the `threshold` is **linear** amplitude (not dB) while `attack`/`release` are milliseconds.

Schemas are Zod discriminated unions (`src/core/schemas.ts`); adding an operation type means one schema case plus one compiler/validator entry — the execution engine does not change. Timestamps are seconds, everywhere, in every layer.

## Workflow: observe → plan → preview → render

1. **Observe** — `video inspect` for facts; run the workers the task needs (`detect-silence`, `detect-scenes`, `transcribe`, …). To actually *look* at the material before judging: `extract-frame --at t1,t2` for specific moments, `review-frames --scenes scenes.json` for grouped stills around every scene boundary, `generate-proxy` for a cheap watchable copy. Cached observations make re-runs free.
2. **Plan** — turn observations into ops: scaffold with `video plan`, pre-fill via a bridge (`--cuts-from`, `--highlights-from`), then prune and tune by judgment — that part is yours.
3. **Validate** — `video validate` until `valid: true`; branch on the error `code` to fix problems programmatically.
4. **Preview** — `video preview` writes `<output>.preview.mp4` (640w, ultrafast, CRF 30), so iterating can never clobber the final. Inspect the result with `extract-frame`/`review-frames` and loop back to the plan.
5. **Render** — `video render`, once, when the plan is approved: one pass, final settings (CRF 18, `medium`, AAC 192k). `--force` is required to overwrite an existing output, and the source can never be an output. `--encoder libx264|h264_videotoolbox` overrides the codec choice; `video benchmark <input>` measures which is fastest on your machine.

## Errors

Every failure boundary reports a stable, machine-readable code — branch, fix, retry:

```json
{"valid":false,"errors":[{"code":"TIMESTAMP_OUT_OF_RANGE","operation":1,"message":"trim: range [0, 100] exceeds source duration 12.000s"}],"warnings":[]}
```

The full code list (`SOURCE_NOT_FOUND`, `MIX_INPUT_NOT_FOUND`, `OBSERVATION_INVALID`, `TRANSCRIPTION_ENGINE_FAILED`, …) lives in [`AGENTS.md`](./AGENTS.md#error-codes-branch-on-code-fix-retry).

## MCP server

The same engine is exposed as an MCP stdio server — a thin adapter over the engine functions the CLI uses (the engine has no knowledge of MCP or any AI provider):

```sh
video mcp        # or: video-mcp
```

Every CLI command becomes a `video_<command>` tool (`video_inspect`, `video_render`, `video_detect_silence`, `video_review_frames`, …). Client config (ZCode/Claude-style):

```json
{
  "mcpServers": {
    "video": { "command": "video-mcp" }
  }
}
```

Tool results are the same compact JSON the CLI emits; failures arrive as `isError` results carrying the same `{error: {code, message}}` objects, so error branching is identical across CLI and MCP.

## Architecture

```
CLI (src/cli)                    thin dispatch, compact JSON out
agent/ (src/agent)               MCP stdio adapter — same engine functions
  ↓
core/schemas                     Zod: edit plan + observation schemas
core/timeline                    ops → keep-segments (pure math, fully tested)
validate/                        plan + media facts → ValidationReport
media/ffmpeg                     command builder (argv arrays only) + runner
render/                          preview/final settings, single-pass render
analysis/                        workers: silence, scenes, transcribe, filler,
                                 highlights, frames, review-frames, proxy
captions/                        srt/vtt generation + timeline cue remapping
hardware/ · benchmark/           diagnose: capabilities discovered, not assumed;
                                 measured encoder × concurrency matrix
cache/                           .video-agent/cache/<source-id>/ (path+size+mtime)
```

FFmpeg command construction lives in exactly one module; the CLI never sees a command string. `--debug` prints every generated command plus per-stage timings.

## Development

```sh
npm run typecheck
npm test         # unit + integration; the suite generates its own 12 s fixture — no videos committed
```
