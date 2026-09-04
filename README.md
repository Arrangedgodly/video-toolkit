# video-toolkit

Agent-native video editing toolkit: deterministic tools, a versioned **edit plan** as the single artifact between judgment and execution, and **one-pass FFmpeg rendering** — so humans and AI agents never hand-write FFmpeg commands, parse raw ffprobe output, or reason about codecs.

> [!NOTE]
> **For AI agents:** [`AGENTS.md`](./AGENTS.md) is the canonical, machine-first contract reference — commands, schemas, error codes, engine contracts, extension rules. This README is the human-facing overview; when the two ever disagree, AGENTS.md wins.

## Why it exists

Editing video with an agent (or a shell) usually means stringing together FFmpeg incantations and hoping. This toolkit splits the work cleanly: **LLMs and humans make editorial decisions** (what to keep, whether a pause is dead air, what makes a good highlight); **deterministic software handles everything else** — metadata, timestamps, command construction, validation, encoding. No LLM runs inside this package. Workers observe, bridges propose, and the plan is the only path to a render, so transcription engines, encoders, and agent frameworks can all be swapped without touching the editing model. (The single-pass multi-range FFmpeg recipe and timeline semantics were ported from the tested `vedit` CLI in the same workspace.)

## Prerequisites

- Node.js ≥ 20
- `ffmpeg` and `ffprobe` on `PATH` — burned captions additionally require a build with **libass** (e.g. Homebrew's `ffmpeg-full`); `video diagnose` reports what your build supports
- Optional transcription engines (see [engines](./AGENTS.md#engines-transcription)): Handy.app on macOS (Parakeet, the default) and/or `whisper-cli` (whisper.cpp) with a model in `.video-agent/models/` (default name `ggml-base.en.bin`) — without a resolvable engine, `transcribe` fails with the machine-readable `TRANSCRIPTION_ENGINE_UNAVAILABLE` instead of guessing

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
video transitions          crossfade kinds on this ffmpeg build (JSON)
```

### Analysis workers (timestamped observations; never render)

```
video detect-silence <input>       silence gaps
video detect-scenes <input>        scene-cut boundaries
video transcribe <input>           timestamped transcript (--engine handy|whisper-cpp;
                                   --word-timestamps = per-word times via whisper-cpp)
video detect-filler <t.json>       filler-word candidates from a transcript
                                   (params.precision: "words" = exact per-word
                                   anchors when the transcript carries word
                                   timings, "segments" = estimates)
video find-highlights <input>      highlight proposals (--transcript, --keywords)
video measure-loudness <input>     source loudness (LUFS, true peak) — the evidence
                                   for normalize-audio/volume targeting
video captions <t.json>            transcript → .srt or .vtt; --plan remaps cue times through cuts
video extract-frame <input>        jpg stills at --at t1,t2 / --count N
video review-frames <input>        stills grouped around every scene boundary (--scenes s.json)
video generate-proxy <input>       low-cost review copy (default 480w, CRF 28)
```

- **Observations are cached** per (source fingerprint, parameters) under `.video-agent/cache/` — an unchanged source costs nothing on re-analysis. Workers never modify the source and never render; a video without audio yields an empty report with a `note`, not an error.
- **Transcription** runs on swappable engines behind one interface. Implemented: **handy** (Parakeet models on Apple Silicon), which emits whole-file text without timestamps — so the worker windows the audio (default 25 s chunks, boundaries snapped to nearby silence; times exact by construction) and can run windows in parallel (`--concurrency N`, byte-identical output to sequential); and **whisper-cpp** (`whisper-cli` on PATH, model under `.video-agent/models/`), which emits native segments from one whole-file invocation — `video transcribe input.mp4 --word-timestamps` selects it (explicitly or implicitly) and adds per-word `segments[].words` timings for exact filler cuts and word-anchored review.
- **find-highlights** scores transcript segments (speech rate, pause-before emphasis, keyword hits, length band) into deterministic proposals with reasons attached — the agent makes the editorial call.
- **measure-loudness** runs the loudnorm first pass as a cached observation (integrated loudness in LUFS, true peak, range, threshold; no output file — a probe, not a render), so loudness decisions have evidence: the gain to reach a target is `target − inputI` dB, fed to `normalize-audio.target` or a `volume` op.
- **Captions** come in two pieces: `video captions transcript.json --plan plan.json -o out.srt` remaps source-timed cues onto the edited output timeline (a cue spanning a cut splits; fragments under 0.3 s drop), and burning them is a plan operation rendered in the same single pass. Output format follows the `-o` extension (`.srt` default or `.vtt` for WebVTT), with `--format srt|vtt` as explicit override.

### Observation → plan bridges

`video plan` can pre-fill ops from a report — deterministic expansion, editorially inert:

```sh
video plan input.mp4 --cuts-from silence.json [--min-duration 0.5] [--pad 0.25]
video plan input.mp4 --cuts-from filler.json  [--filler-pad-before 0.10] [--filler-pad-end 0.25]
video plan input.mp4 --highlights-from highlights.json [--count 5] [--min-score 0.35] [--pad 0.5]
```

Silence gaps and filler instances become `cut` ops (filler times are exact per-word anchors when the transcript carries word timings — `params.precision: "words"`; linear estimates otherwise — verify with `extract-frame --at` in that mode); highlight candidates become a `trim`-compilation replacing the whole-source keep. One bridge per invocation. The parameters are the editorial decisions; whatever you delete or tune afterwards is judgment.

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
      "duck": { "threshold": 0.02, "ratio": 8, "attack": 20, "release": 400 } },
    { "type": "crossfade", "duration": 0.5, "kind": "fade" }
  ],
  "output": { "path": "output.mp4", "mode": "final" }
}
```

**Timeline ops** (`trim`, `cut`) select source ranges; multiple `trim`s union. **Transform ops** (`speed`, `resize`, `volume`, `normalize-audio`, `audio-mix`, `overlay-text`, `zoom`) apply to the whole output — at most one of each per plan — and compose into the same single pass (audio follows `speed` via an `atempo` chain; `volume` takes `db` or `factor`, exactly one). `audio-mix` layers a looping music bed under the program audio with speech-keyed sidechain ducking: `level` is bed gain in dB, and inside `duck` the `threshold` is **linear** amplitude (not dB) while `attack`/`release` are milliseconds. `overlay-text` burns a title card or lower third in the same pass — literal text with an optional `from`/`to` visibility window on the output timeline and a `position` (top/center/bottom); it uses a fixed system font (see AGENTS.md for the path and defaults). `zoom` adds Ken Burns camera motion — `mode` is the camera direction (`in`/`out` zooms, `left`/`right`/`up`/`down` pans), `factor` the zoom level (default 1.2, strictly 1.0 < f ≤ 2.0), `easing` the ramp shape (`smooth` by default) — riding the same single pass on both the cut path and the crossfade chain without changing the output duration by a single frame; on crossfade plans each segment re-runs the ramp (see AGENTS.md for the full semantics and fences). The **transition op** `crossfade` (at most one per plan, not combinable with `audio-mix`) joins the kept segments with fade transitions instead of hard cuts — still one FFmpeg pass; output duration shrinks by `(N−1)·duration`, the fade must be shorter than every kept segment (0.05 s floor; see AGENTS.md for the full rule table), and `video captions --plan` remaps cue times through the shrinkage so burned captions stay aligned. `video transitions` lists the transition kinds this FFmpeg build actually supports — parsed live from `ffmpeg -h filter=xfade` and cached per version, never a hand-maintained list — and is the menu for `crossfade.kind`: every advertised kind is schema-accepted and was parametrically verified to render (exit 0, exact duration law, decodable output). The one exception is the `custom` sentinel, which parses but is always rejected with a specific error (it needs FFmpeg's `expr=` option and is not a standalone transition). Typical durations 0.2–1.0 s.

The **terminal export op** `export-gif` (at most one per plan, must be the last operation — the plan's only order constraint) renders the compiled output timeline to an animated GIF in the same single FFmpeg pass: the color palette is generated *inside* the one filter graph via `split`/`palettegen`/`paletteuse` (the recipe proven in the `vedit` CLI), never as a separate palette pass. `width` (default 480) and `fps` (default 12) control size and smoothness; `from`/`to` select a sub-range of the **output** timeline (after trims, speed, and crossfade shrinkage — the convenient way to cut a short loop out of a long edit); height keeps the source aspect. GIF carries no audio, so audio is dropped by design (validate emits a `GIF_AUDIO_DROPPED` warning on an audio-bearing source), and `output.path` must end in `.gif`. Previews render a real `<output>.preview.gif`.

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

The same engine is exposed as an MCP server — a thin adapter over the engine functions the CLI uses (the engine has no knowledge of MCP or any AI provider) — over stdio or streamable HTTP:

```sh
video mcp          # stdio (or: video-mcp)
video mcp-serve    # streamable HTTP on http://127.0.0.1:8765/mcp
```

Every CLI command becomes a `video_<command>` tool (`video_inspect`, `video_render`, `video_detect_silence`, `video_review_frames`, …). Stdio client config (ZCode/Claude-style):

```json
{
  "mcpServers": {
    "video": { "command": "video-mcp" }
  }
}
```

Tool results are the same compact JSON the CLI emits; failures arrive as `isError` results carrying the same `{error: {code, message}}` objects, so error branching is identical across CLI and MCP.

### Streamable HTTP

`video mcp-serve [--port 8765] [--host 127.0.0.1] [--token <bearer>]` serves the same tools over MCP streamable HTTP: a single `/mcp` endpoint with plain-JSON replies (no SSE), optional sessions (a `Mcp-Session-Id` is issued at `initialize`; `DELETE` ends one), and transport failures as HTTP statuses — `405` on GET, `401` for a bad bearer token, `403` for a foreign `Origin`, `400` for bad JSON or an unsupported protocol-version header. `--token` is mandatory when `--host` is anything but loopback: the endpoint can run ffmpeg over arbitrary local files. HTTP client config:

```json
{
  "mcpServers": {
    "video": {
      "type": "http",
      "url": "http://127.0.0.1:8765/mcp",
      "headers": { "Authorization": "Bearer <token>" },
      "timeoutMs": 600000
    }
  }
}
```

Long renders need a generous client timeout — without SSE there is no progress push (the same blackout as stdio).

## Architecture

```
CLI (src/cli)                    thin dispatch, compact JSON out
agent/ (src/agent)               MCP adapters — stdio + streamable HTTP,
                                 same engine functions, shared dispatcher
  ↓
core/schemas                     Zod: edit plan + observation schemas
core/timeline                    ops → keep-segments (pure math, fully tested)
validate/                        plan + media facts → ValidationReport
media/ffmpeg · media/transitions command builder (argv arrays only) + runner;
                                 live xfade transition catalog (environment query)
render/                          preview/final settings, single-pass render
analysis/                        workers: silence, scenes, transcribe, filler,
                                 highlights, frames, review-frames, proxy,
                                 measure-loudness
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
