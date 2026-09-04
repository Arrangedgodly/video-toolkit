import { runFFmpeg } from "../media/ffmpeg.js";
import { runAnalysis, round3, type AnalysisOpts } from "./runner.js";
import { SceneReport } from "../core/schemas.js";
import type { z } from "zod";

export type SceneReportData = z.infer<typeof SceneReport>;

const PTS_TIME_RE = /pts_time:([\d.]+)/;
const SCORE_RE = /lavfi\.scene_score=([\d.]+)/;

/**
 * Parse the metadata=print output of `select='gt(scene,T)'`. Frames that pass
 * the gate are printed with their pts_time followed by the scene score —
 * that score is the confidence, so the report is threshold-consistent.
 */
export function parseSceneOutput(stderr: string): { timestamp: number; confidence: number }[] {
  const boundaries: { timestamp: number; confidence: number }[] = [];
  let pendingTime: number | null = null;
  for (const line of stderr.split("\n")) {
    const t = PTS_TIME_RE.exec(line);
    if (t) {
      pendingTime = Number(t[1]);
      continue;
    }
    const s = SCORE_RE.exec(line);
    if (s && pendingTime !== null) {
      boundaries.push({ timestamp: pendingTime, confidence: Number(s[1]) });
      pendingTime = null;
    }
  }
  return boundaries;
}

export async function detectScenes(
  input: string,
  params: { threshold: number },
  opts: AnalysisOpts = {},
): Promise<SceneReportData> {
  return runAnalysis<SceneReportData>(
    input,
    { ...opts, cacheName: `scenes-t${params.threshold.toFixed(2)}.json` },
    async ({ media }) => {
      if (!media.video) {
        return { boundaries: [], duration: round3(media.duration), note: "no video stream" };
      }
      const r = await runFFmpeg([
        "-nostdin", "-hide_banner",
        "-i", input,
        "-an",
        "-vf", `select='gt(scene,${params.threshold})',metadata=print`,
        "-f", "null", "-",
      ]);
      const report: SceneReportData = {
        boundaries: parseSceneOutput(r.stderr).map((b) => ({
          timestamp: round3(b.timestamp),
          confidence: Math.min(1, round3(b.confidence)),
        })),
        duration: round3(media.duration),
        params: { threshold: params.threshold },
      };
      return SceneReport.parse(report);
    },
  );
}
