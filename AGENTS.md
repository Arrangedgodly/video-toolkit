# AGENTS.md — video-toolkit contract reference (machine-first)

Format rules for this file: DOC-CONVENTIONS (bottom). Updating behavior anywhere in src/ obligates updating the matching table here in the same change — see EXTENSION RULES.

STATUS: milestone 5 complete · 99 tests (`npm test`, ~20 s; transcription tests skip without an engine) · binary `video` on PATH (npm link) · node ≥ 20, ffmpeg/ffprobe required.

## GLOSSARY (canonical terms — never synonymize)

- **plan** — versioned JSON declaring an edit; the only input to render.
- **observation** — timestamped JSON emitted by a worker; never rendered, never mutates source.
- **worker** — deterministic analysis producing an observation (detect-silence, detect-scenes, transcribe, detect-filler).
- **bridge** — deterministic observation→plan expansion (`plan --cuts-from`).
- **timeline op** — `trim`/`cut`: absolute source-time ranges; order-independent; trims union, cuts subtract.
- **transform op** — `speed`/`resize`/`volume`/`normalize-audio`: global, ≤ 1 each per plan.
- **engine** — swappable transcription backend behind one interface (`src/analysis/transcribe/engines.ts`).
- **preview** — cheap render to `<output>.preview.mp4` (640 w, ultrafast, CRF 30); can never touch the final path.
- **source-id** — cache key = sha1(absPath|size|mtimeMs); changed file ⇒ new id, no invalidation logic.

## COMMANDS

Stdout = compact single-line JSON unless `--pretty`. Progress/debug/errors → stderr. Global flags: `--pretty --debug --no-cache`. Timestamps: seconds (float), 3 decimals in emitted JSON.

| command | args | own flags | stdout contract | cache |
|---|---|---|---|---|
| `inspect` | `<input>` | `--json` (raw ffprobe) | `{file, duration, video?:{codec,width,height,fps,bitrate,pixelFormat}, audio?:{codec,sampleRate,channels,bitrate}}` | metadata.json |
| `plan` | `<input>` | `--cuts-from <silence.json> --min-duration <s=0.5> --pad <s=0.25>` | whole-source EditPlan (scaffold; agent refines) | metadata.json |
| `validate` | `<plan>` | — | `{valid, errors[], warnings[], timelineDuration?}`; exit 0/1 | metadata.json |
| `preview` | `<plan>` | `--force` | RenderResult (mode preview) | metadata.json |
| `render` | `<plan>` | `--force --encoder libx264\|h264_videotoolbox --mode final\|preview` | RenderResult `{output, mode, encoder, timelineSegments, timelineDuration, outputDuration, wallMs, command[]}` | metadata.json |
| `diagnose` | — | — | `{os, cpu, memory, binaries, ffmpeg:{hwaccels, encoders:{h264,hevc,av1}}}` | none |
| `benchmark` | `<input>` | `--seconds <n=6>` | `{segmentSeconds, recommended:{encoder, renderConcurrency}, results[]}` (measured, not inferred) | benchmark.json |
| `detect-silence` | `<input>` | `--threshold <dB=35> --min-duration <s=0.5>` | SilenceReport | silence-t<thr>-d<min>.json |
| `detect-scenes` | `<input>` | `--threshold <0..1=0.4>` | SceneReport | scenes-t<thr>.json |
| `transcribe` | `<input>` | `--engine handy --model <id> --chunk <s=25> --no-snap` | TranscriptReport | transcript-<engine>-<model>-c<chunk>.json |
| `detect-filler` | `<transcript.json>` | `--words "um,uh,…"` | FillerReport | none (pure transform) |
| `find-highlights` | `<input>` | `--transcript <t.json> --keywords "a,b" --min-score <0.35> --count <5>` | HighlightReport | silence cache reused |
| `captions` | `<transcript.json>` | `--plan <p.json> -o <out.srt>` | `{output, cues, dropped, remapped}` | none |
| `extract-frame` | `<input>` | `--at t1,t2 \| --count n=6 --size w --dir d` | `{dir, frames[]}` (jpg paths) | metadata.json |
| `generate-proxy` | `<input>` | `--width 480 --output f` | `{proxy, width, duration, wallMs, command[]}` | none |
| `mcp` | — | — | MCP stdio server (see ADAPTERS) | — |

## WORKFLOWS (proven sequences; steps are the contract)

- **W1 basic edit**: `inspect` → `plan > plan.json` → edit `operations` → `validate` until valid → `preview` → iterate → `render` once.
- **W2 tighten silence**: `detect-silence > silence.json` → `plan --cuts-from silence.json > plan.json` (tune `--min-duration`/`--pad` = the editorial decisions) → prune cuts by judgment → W1 tail.
- **W3 speech review**: `transcribe > transcript.json` → `detect-filler transcript.json` → (agent judges which instances are dead air) → express removals as `cut` ops → W1 tail. Filler times are linear estimates within segment granularity — verify with `extract-frame --at` before cutting.
- **W4 strategy**: `diagnose` → `benchmark` → pass `--encoder` to render accordingly.
- **W5 MCP**: `video mcp` (or bin `video-mcp`); tools = `video_<command_snake_case>`; results identical to CLI stdout; failures = `isError:true` + `{error:{code,message,details}}`.

## PLAN SCHEMA v1

`{version:1, source, operations[], output:{path, mode:"final"|"preview"}}` — Zod source of truth: `src/core/schemas.ts` (do not restate here). Timeline math: `src/core/timeline.ts` (pure, unit-tested).

| op | keys | semantics |
|---|---|---|
| `trim` | `start,end` (s) | keep range; multiple trims union |
| `cut` | `start,end` (s) | remove range from keeps |
| `speed` | `factor` (0<f≤10) | global; audio follows (atempo-chained) |
| `resize` | `width[, height]` (px) | global; width-only keeps aspect |
| `volume` | `db` XOR `factor` | global; factor→dB = 20·log₁₀(f) |
| `normalize-audio` | `target?` (LUFS, default −16) | single-pass loudnorm |
| `captions` | `file`, `style?` (ASS force_style) | burns .srt in the same pass. **CUE TIMES ARE OUTPUT-TIMELINE**: source-timed srt must be remapped first via `video captions --plan` (cues spanning cuts split; fragments <0.3 s drop) |

Rules: ops order-independent · ≤1 of each transform · renders are ONE ffmpeg pass (select-based multi-range) · preview path ≠ final path · `--force` required to overwrite explicit outputs · source can never be an output.

## ERROR CODES (branch on `code`, fix, retry)

`PLAN_INVALID_JSON` plan not JSON · `PLAN_SCHEMA_INVALID` Zod fail (details.issues[]) · `SOURCE_NOT_FOUND` · `TIMESTAMP_OUT_OF_RANGE` op beyond source duration · `RANGE_NEGATIVE` start ≥ end · `EMPTY_TIMELINE` ops remove everything · `OPERATION_INVALID` duplicate transform / volume param / unknown MCP tool · `OUTPUT_PATH_INVALID` · `OUTPUT_WOULD_OVERWRITE_SOURCE` · `OUTPUT_EXISTS` (use --force) · `FFMPEG_FAILED` (details.command + stderrTail) · `FFMPEG_NOT_FOUND` · `FFPROBE_NOT_FOUND` · `UNSUPPORTED_MEDIA` · `OBSERVATION_INVALID` observation file unparsable · `TRANSCRIPTION_ENGINE_UNAVAILABLE` (details.probed[]) · `TRANSCRIPTION_ENGINE_FAILED`.

## OBSERVATION SCHEMAS

Zod source of truth: `src/core/schemas.ts`. Shapes: SilenceReport `{segments:[{start,end,duration}], duration?, note?, params?}` · SceneReport `{boundaries:[{timestamp,confidence}]…}` · TranscriptReport `{segments:[{start,end,text}], engine?, model?, params?}` · FillerReport `{instances:[{start,end,phrase,context}], params?}` · HighlightReport `{candidates:[{start,end,score,text,reasons[]}], params?}` (score = weighted speech-rate 0.45 / pause-before 0.2 / keyword 0.25 / length-band 0.1, renormalized when keywords unset; deterministic proposal — the agent decides).

## ENGINES (transcription)

- **handy** (implemented; priority 1): binary `/Applications/Handy.app/Contents/MacOS/handy` (or `~/Applications/…`). Headless: `-f <16kHz-mono.wav> --json [--model <id>]`. stdout = single JSON `{text, model, best_ms, audio_secs, rtf,…}`; logs → stderr; **exits in `-f` mode; `--list-models` mode never exits — always wrap with timeout**. Default model on this machine: `parakeet-tdt-0.6b-v3` (Q8_0, Metal; 5–21× realtime measured).
- **No native segments** ⇒ toolkit windows the audio (chunk default 25 s, boundaries snapped to silence gaps ±chunk/3, exact times by construction). 1 h source ≈ minutes; cached per source+engine+model+chunk.
- Add an engine: implement `TranscriptionEngine` (`src/analysis/transcribe/engines.ts`), append to `ENGINES` (priority = agent-efficiency order), parser unit test, update this table.

## ENVIRONMENT FACTS (this machine; re-run `video diagnose` to confirm)

- ffmpeg 9.0.1 **ffmpeg-full** (libass + freetype present → burned captions work; `subtitles`/`drawtext` filters available) via `brew unlink ffmpeg && brew link --force ffmpeg-full` (ffmpeg-full is keg-only; reverse with unlink ffmpeg-full + link ffmpeg; scrcpy keeps working — full build is a functional superset). videotoolbox hwaccel + h264/hevc encoders present.
- Note: the full 9.0.1 bottle renders ~2–3× slower than the old minimal 8.1.2 did (verified in test timings); benchmark cache is keyed by ffmpeg version so `video benchmark` re-measures after upgrades.
- Apple M2, 8 cores, 16 GB. Re-run `video benchmark <input>` for current per-source recommendations.

## INVARIANTS (violating these is a bug)

1. One ffmpeg pass per render — no intermediate encodes.
2. Source is never written; explicit outputs need `--force`; preview never writes the final path.
3. Workers never render; render never reads observations (plans are the only bridge).
4. All timestamps: seconds, float, emitted at 3 decimals.
5. Child processes: argv arrays only; engines wrapped with timeout.

## EXTENSION RULES (self-enforcing — do the doc update in the same change)

new command → COMMANDS row + cli case + tests · new plan op → PLAN SCHEMA row + validate rules + builder + tests · new worker → COMMANDS row + schema + runner + tests · new error code → ERROR CODES · new engine → ENGINES · behavior change → the one table that states it.

## DOC-CONVENTIONS

Machine-first: stable ALL-CAPS section keys · tables with fixed columns · literal JSON · units explicit (s, dB, px, LUFS, ×) · one canonical term per concept (GLOSSARY) · facts owned by code (`--help`, Zod schemas) are pointed at, never restated · every line carries a fact; no prose padding · examples must be runnable verbatim.
