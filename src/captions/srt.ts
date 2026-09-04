import type { Segment } from "../core/timeline.js";
import type { z } from "zod";
import type { TranscriptReport } from "../core/schemas.js";

/** Subtitle generation: transcript segments → SRT cues, optionally remapped
 * through a plan's compiled timeline so cue times match the EDITED output. */

export interface Cue {
  start: number;
  end: number;
  text: string;
}

export function formatSrtTime(t: number): string {
  const ms = Math.max(0, Math.round(t * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const milli = ms % 1000;
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(milli, 3)}`;
}

export function formatSrt(cues: Cue[]): string {
  return (
    cues
      .map((c, i) => {
        const text = c.text.replace(/\s*[\r\n]+\s*/g, " ").trim();
        return `${i + 1}\n${formatSrtTime(c.start)} --> ${formatSrtTime(c.end)}\n${text}`;
      })
      .join("\n\n") + "\n"
  );
}

export function transcriptToCues(report: z.infer<typeof TranscriptReport>): Cue[] {
  return report.segments
    .filter((s) => s.text.trim().length > 0 && s.end > s.start)
    .map((s) => ({ start: s.start, end: s.end, text: s.text }));
}

const MIN_CUE = 0.3;

/**
 * Map a source-timed cue onto the output timeline defined by keep-segments.
 * A cue spanning a cut splits into one cue per surviving intersection; cues
 * (or fragments) shorter than MIN_CUT seconds are dropped.
 */
export function mapCueThroughTimeline(cue: Cue, segments: Segment[]): Cue[] {
  const out: Cue[] = [];
  let outputTime = 0;
  for (const seg of segments) {
    const s = Math.max(cue.start, seg.start);
    const e = Math.min(cue.end, seg.end);
    if (e - s >= MIN_CUE) {
      out.push({
        start: outputTime + (s - seg.start),
        end: outputTime + (e - seg.start),
        text: cue.text,
      });
    }
    outputTime += seg.end - seg.start;
  }
  return out;
}

export function mapCuesThroughTimeline(cues: Cue[], segments: Segment[]): Cue[] {
  const merged = cues.flatMap((c) => mapCueThroughTimeline(c, segments));
  // renumber-safe: sort by start, merge same-text adjacents (cue split at a
  // rejoining boundary would duplicate text back-to-back)
  merged.sort((a, b) => a.start - b.start);
  const out: Cue[] = [];
  for (const c of merged) {
    const last = out[out.length - 1];
    if (last && last.text === c.text && c.start - last.end < 0.05) {
      last.end = c.end;
    } else {
      out.push({ ...c });
    }
  }
  return out;
}
