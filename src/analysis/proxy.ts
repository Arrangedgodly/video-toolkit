import path from "node:path";
import { ToolError } from "../core/errors.js";
import { runFFmpeg } from "../media/ffmpeg.js";
import { cachedInspect, type CacheOpts } from "../cache/cache.js";

export interface ProxyResult {
  proxy: string;
  width: number;
  duration: number;
  wallMs: number;
  command: string[];
}

/** Generate a low-cost review copy (default 480w, CRF 28) so agents and humans
 * can inspect content without touching the source or the final pipeline. */
export async function generateProxy(
  input: string,
  opts: CacheOpts & { width?: number; output?: string } = {},
): Promise<ProxyResult> {
  const media = await cachedInspect(input, opts);
  if (!media.video) {
    throw new ToolError("UNSUPPORTED_MEDIA", "generate-proxy needs a video stream");
  }
  const width = opts.width ?? 480;
  const stem = path.basename(input).replace(/\.[^.]+$/, "");
  const output = opts.output ?? `${stem}.proxy.mp4`;

  const args = [
    "-nostdin", "-hide_banner", "-y",
    "-i", input,
    "-vf", `scale=${width}:-2,format=yuv420p`,
    "-c:v", "libx264", "-crf", "28", "-preset", "veryfast",
    ...(media.audio ? ["-c:a", "aac", "-b:a", "64k"] : ["-an"]),
    "-movflags", "+faststart",
    output,
  ];
  const r = await runFFmpeg(args);
  return {
    proxy: path.resolve(output),
    width,
    duration: media.duration,
    wallMs: r.durationMs,
    command: r.command,
  };
}
