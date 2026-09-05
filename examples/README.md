# examples/ — runnable plan cookbook

Seven example plans, one per flagship workflow. Each is a static `.json` you can run from scratch:

```sh
mkdir demo && cd demo
#   1. paste the input recipes below (regenerates input.mp4, speech.mp4, bed.mp3, logo.png, captions.srt)
#   2. copy an example plan into the directory, then:
video validate silence-tighten.json      # {valid: true, ...}
video plan lint silence-tighten.json     # {suggestions: []} — advisory, exit 0
video preview silence-tighten.json       # cheap render to <output>.preview.mp4
video render silence-tighten.json        # the final single-pass render
```

Plans reference inputs by stable relative names (`input.mp4`, `speech.mp4`, `bed.mp3`, `logo.png`, `captions.srt`), so they validate from any directory containing the generated inputs. Smoke-validated by `src/test/examples.test.ts` (validate + lint + one preview per example, on the lavfi recipes).

## Index

| plan | workflow | one line | inputs |
|---|---|---|---|
| `silence-tighten.json` | W2 | cut two measured silence gaps (bridge output of `--cuts-from silence.json`, pad 0.25 each side) and normalize loudness | `input.mp4` |
| `filler-cut.json` | W3 | cut filler words at exact word anchors (bridge output of `--cuts-from filler.json`, pads 0.10/0.25) | `speech.mp4` |
| `highlights.json` | W6 | keep only the top-3 highlight candidates (bridge output of `--highlights-from highlights.json`, pad 0.5) | `speech.mp4` |
| `watermark-captions.json` | W1 | trim a tutorial segment and burn a logo watermark (`image-overlay`) plus captions in the same pass | `input.mp4`, `logo.png`, `captions.srt` |
| `montage-crossfade-zoom.json` | W1 | join three trims with 0.5 s crossfades and a Ken Burns zoom (11 s output = 12 − 2·0.5) | `input.mp4` |
| `gif-preview.json` | W1 | export a 3 s loop window of a sped-up edit as a 480 px / 12 fps GIF | `input.mp4` |
| `audio-mix.json` | W1 | mix a looping music bed at −18 dB under the first 10 s of speech with default sidechain ducking | `speech.mp4`, `bed.mp3` |

All seven run anywhere ffmpeg/ffprobe exist (CI included) using the recipes below — no transcription engine, model, or system font is needed for the shipped plans. Only the optional realism path for `speech.mp4` is darwin-only (`say`); the lavfi fallback runs everywhere.

## Input recipes (ffmpeg lavfi one-liners, verbatim)

`input.mp4` — 21 s 1280x720@30 test pattern with a 440 Hz voice stand-in and REAL silence gaps baked at [4, 6] and [12, 14.5] (so `detect-silence` genuinely finds them):

```sh
ffmpeg -y -f lavfi -i testsrc2=size=1280x720:rate=30 -f lavfi -i sine=frequency=440 \
  -af "volume=0:enable='between(t,4,6)+between(t,12,14.5)'" \
  -t 21 -c:v libx264 -pix_fmt yuv420p -c:a aac input.mp4
```

`speech.mp4` — darwin (real speech; the fixed sentence runs ~22 s and the command pads to exactly 22 s so every plan timestamp sits strictly inside):

```sh
say -o speech.aiff "Um, you know, welcome to the toolkit walkthrough. Uh, basically, the plan is the single artifact between judgment and the render. You know, workers observe, bridges propose, agents decide. First, inspect the source and detect silence. Second, transcribe with word timestamps for exact filler cuts. Finally, mix a music bed and render once."
ffmpeg -y -i speech.aiff -f lavfi -i testsrc2=size=1280x720:rate=30 \
  -filter_complex "[0:a]apad[sa]" -map 1:v -map "[sa]" \
  -t 22 -c:v libx264 -pix_fmt yuv420p -c:a aac speech.mp4
```

`speech.mp4` — any OS (lavfi fallback: the same fixed-duration container with tone pauses standing in for filler pauses; what CI and the smoke test use):

```sh
ffmpeg -y -f lavfi -i testsrc2=size=1280x720:rate=30 -f lavfi -i "sine=frequency=440" \
  -af "volume=0:enable='between(t,1.0,1.2)+between(t,6.1,6.6)'" \
  -t 22 -c:v libx264 -pix_fmt yuv420p -c:a aac speech.mp4
```

`bed.mp3` — 6 s looping music-bed stand-in (tremolo-modulated low tone):

```sh
ffmpeg -y -f lavfi -i sine=frequency=220 -af "tremolo=f=2:d=0.6" -t 6 bed.mp3
```

`logo.png` — one-frame lavfi generate-and-extract (semi-transparent blue square, alpha carried by `format=rgba`):

```sh
ffmpeg -y -f lavfi -i "color=c=0x3399FF@0.9:s=128x128,format=rgba" -frames:v 1 logo.png
```

`captions.srt` — hand-written cue block already on the OUTPUT timeline (the `watermark-captions.json` trim [2, 12] produces a 10 s output, cues cover 0–10 s):

```sh
cat > captions.srt <<'EOF'
1
00:00:00,000 --> 00:00:03,000
Welcome to the toolkit walkthrough.

2
00:00:03,000 --> 00:00:07,000
Workers observe, bridges propose, agents decide.

3
00:00:07,000 --> 00:00:10,000
Validate, preview, then render once.
EOF
```

## Producing the bridge-derived plans (the real workflow)

The silence/filler/highlights examples ship the RESULTING plan shape of their workflow — the producing commands are the point:

```sh
# silence-tighten.json (W2) — input.mp4's baked gaps make this reproducible:
video detect-silence input.mp4 > silence.json
video plan input.mp4 --cuts-from silence.json --pad 0.25 > silence-tighten.json   # ≈ cuts [4.25,5.75], [12.25,14.25]

# filler-cut.json (W3) — needs a word-timestamped transcript (whisper-cpp engine):
video transcribe speech.mp4 --word-timestamps > transcript.json
video detect-filler transcript.json --words "um,uh,you know,basically" > filler.json
video plan speech.mp4 --cuts-from filler.json --filler-pad-before 0.10 --filler-pad-end 0.25 > filler-cut.json

# highlights.json (W6):
video find-highlights speech.mp4 --transcript transcript.json --keywords "toolkit,plan,render" > highlights.json
video plan speech.mp4 --highlights-from highlights.json --count 3 --pad 0.5 > highlights-plan.json
```

## What is synthetic (honestly)

`input.mp4` and the lavfi `speech.mp4` are test patterns — deterministic stand-ins with fixed durations (21 s / 22 s) chosen so every plan timestamp sits strictly inside. The shipped cut/trim times in the bridge examples are plausible shapes, not your transcript's exact anchors: re-run the producing commands above against your regenerated inputs to derive real ones (word anchors vary with the `say` voice and engine). `video captions transcript.json --plan plan.json -o captions.srt` is the real producing command for caption files from source-timed transcripts; the recipe block here is already output-timed, so it burns as-is.
