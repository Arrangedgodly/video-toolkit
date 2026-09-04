import { HighlightReport, type TranscriptReport, type SilenceReport } from "../core/schemas.js";
import { round3 } from "./runner.js";
import type { z } from "zod";

export type HighlightReportData = z.infer<typeof HighlightReport>;

export interface HighlightParams {
  /** topic terms; hits raise the keyword component */
  keywords: string[];
  /** minimum score to report (0..1) */
  minScore: number;
  /** at most this many candidates returned */
  maxCount: number;
}

export const DEFAULT_HIGHLIGHT_PARAMS: HighlightParams = {
  keywords: [],
  minScore: 0.35,
  maxCount: 5,
};

// weights are fixed so scores are comparable across runs on the same params
const W_DENSITY = 0.45;
const W_PAUSE = 0.2;
const W_KEYWORD = 0.25;
const W_LENGTH = 0.1;

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/**
 * Deterministic highlight PROPOSALS over transcript + silence observations.
 * Components: speech rate (words/s), pause immediately before the segment
 * (emphasis), keyword hits, and a length band (4-60 s ideal, 2-120 s half).
 * Weights renormalize when keywords are unset. The agent decides what to do
 * with the candidates — this never edits anything.
 */
export function scoreHighlights(
  transcript: z.infer<typeof TranscriptReport>,
  silence: z.infer<typeof SilenceReport>,
  params: HighlightParams = DEFAULT_HIGHLIGHT_PARAMS,
): HighlightReportData {
  const keywords = params.keywords.map((k) => k.toLowerCase().trim()).filter(Boolean);
  const activeWeight =
    W_DENSITY + W_PAUSE + W_LENGTH + (keywords.length > 0 ? W_KEYWORD : 0);

  const scored: z.infer<typeof HighlightReport>["candidates"] = [];

  for (const seg of transcript.segments) {
    const dur = seg.end - seg.start;
    if (dur < 1) continue;
    const words = seg.text.trim().split(/\s+/).filter(Boolean);
    if (words.length < 3) continue;

    const wps = words.length / dur;
    const density = clamp01(wps / 3);
    const reasons = [`${wps.toFixed(1)} words/s`];

    // the largest silence gap ending just before this segment (allowing a
    // small overlap for imprecise chunk boundaries) counts as emphasis
    const pause = Math.max(
      0,
      ...silence.segments.map((s) => {
        const gap = s.end - seg.start;
        return gap >= -0.05 && gap <= 0.25 ? s.end - s.start : 0;
      }),
    );
    const pauseScore = clamp01(pause / 1.5);
    if (pause > 0.2) reasons.push(`${pause.toFixed(1)}s pause before`);

    let keywordScore = 0;
    if (keywords.length > 0) {
      const lower = words.map((w) => w.toLowerCase().replace(/[^a-z0-9']/g, ""));
      const hits: Record<string, number> = {};
      for (const w of lower) {
        if (keywords.includes(w)) hits[w] = (hits[w] ?? 0) + 1;
      }
      const total = Object.values(hits).reduce((a, b) => a + b, 0);
      keywordScore = clamp01(total / 4);
      if (total > 0) {
        reasons.push(
          `keywords: ${Object.entries(hits)
            .map(([w, n]) => (n > 1 ? `${w}×${n}` : w))
            .join(", ")}`,
        );
      }
    }

    const lengthScore = dur >= 4 && dur <= 60 ? 1 : dur >= 2 && dur <= 120 ? 0.5 : 0;

    const raw =
      W_DENSITY * density + W_PAUSE * pauseScore + W_KEYWORD * keywordScore + W_LENGTH * lengthScore;
    const score = round3(raw / activeWeight);

    if (score >= params.minScore) {
      scored.push({
        start: seg.start,
        end: seg.end,
        score,
        text: seg.text.length > 140 ? `${seg.text.slice(0, 137)}…` : seg.text,
        reasons,
      });
    }
  }

  const selected = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, params.maxCount)
    .sort((a, b) => a.start - b.start);

  return HighlightReport.parse({
    candidates: selected,
    duration: transcript.duration,
    params: { keywords, minScore: params.minScore, maxCount: params.maxCount },
  });
}
