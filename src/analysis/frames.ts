import { mkdir } from "node:fs/promises";
import path from "node:path";
import { ToolError } from "../core/errors.js";
import { runFFmpeg } from "../media/ffmpeg.js";
import { cachedInspect, type CacheOpts } from "../cache/cache.js";

export interface ExtractFramesResult {
  dir: string;
  frames: string[];
}

/** Extract ONE viewable still at t (fast-seek: -ss before -i, single frame,
 * optional width downscale). Shared by extract-frame and review-frames —
 * argv-identical to the original inline construction. Returns wall time ms. */
export async function extractStill(
  input: string,
  t: number,
  out: string,
  size?: number,
): Promise<number> {
  const args = [
    "-nostdin", "-hide_banner", "-y",
    "-ss", t.toFixed(3), "-i", input,
    "-frames:v", "1",
    ...(size ? ["-vf", `scale=${size}:-2`] : []),
    "-q:v", "2", out,
  ];
  const r = await runFFmpeg(args);
  return r.durationMs;
}

/** Extract viewable jpg stills at explicit timestamps, or N evenly spaced.
 * This is the agent's "eyes" — cheap, deterministic, no re-encode of source. */
export async function extractFrames(
  input: string,
  opts: CacheOpts & { at?: number[]; count?: number; size?: number; dir?: string } = {},
): Promise<ExtractFramesResult> {
  const media = await cachedInspect(input, opts);
  const debug = opts.debug ?? (() => {});
  if (!media.video) {
    throw new ToolError("UNSUPPORTED_MEDIA", "extract-frame needs a video stream");
  }

  const times =
    opts.at && opts.at.length > 0
      ? opts.at
      : Array.from({ length: opts.count ?? 6 }, (_, i) => (media.duration * (i + 0.5)) / (opts.count ?? 6));

  const stem = path.basename(input).replace(/\.[^.]+$/, "");
  const dir = opts.dir ?? `${stem}-frames`;
  await mkdir(dir, { recursive: true });

  const frames: string[] = [];
  for (let i = 0; i < times.length; i++) {
    const t = times[i]!;
    const out = path.join(dir, `frame_${String(i + 1).padStart(3, "0")}.jpg`);
    const ms = await extractStill(input, t, out, opts.size);
    debug(`frame ${i + 1}/${times.length} @${t.toFixed(2)}s (${ms}ms)`);
    frames.push(path.resolve(out));
  }
  return { dir: path.resolve(dir), frames };
}
