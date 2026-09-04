import { Cache, cachedInspect, type CacheOpts } from "../cache/cache.js";
import type { MediaInfo } from "../media/ffprobe.js";

export interface AnalysisOpts extends CacheOpts {
  /** cache file name; should encode the parameters that affect the result */
  cacheName?: string;
}

export interface AnalysisContext {
  media: MediaInfo;
}

/**
 * Shared shape for every analysis worker: read media facts, compute
 * observations, validate them, cache by (source fingerprint, params).
 * Workers never render and never modify the source — they only observe.
 */
export async function runAnalysis<T>(
  input: string,
  opts: AnalysisOpts,
  compute: (ctx: AnalysisContext) => Promise<T>,
): Promise<T> {
  const debug = opts.debug ?? (() => {});
  const media = await cachedInspect(input, opts);
  if (!opts.noCache && opts.cacheName) {
    const cache = new Cache();
    const id = await cache.sourceId(input);
    const hit = await cache.read<T>(id, opts.cacheName);
    if (hit) {
      debug(`cache hit: ${opts.cacheName} ${id}`);
      return hit;
    }
    const result = await compute({ media });
    await cache.write(id, opts.cacheName, result);
    debug(`cache miss: wrote ${opts.cacheName} ${id}`);
    return result;
  }
  return compute({ media });
}

export function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
