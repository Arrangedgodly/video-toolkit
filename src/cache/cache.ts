import { createHash } from "node:crypto";
import { stat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { inspectFile, type MediaInfo } from "../media/ffprobe.js";

/**
 * Local cache under ./.video-agent/cache/<source-id>/.
 * The source-id fingerprints absolute path + size + mtime, so a changed file
 * is simply a new id — no invalidation logic to get wrong.
 */
export class Cache {
  constructor(private readonly root = ".video-agent/cache") {}

  async sourceId(file: string): Promise<string> {
    const abs = path.resolve(file);
    const st = await stat(abs);
    return createHash("sha1")
      .update(`${abs}|${st.size}|${st.mtimeMs}`)
      .digest("hex")
      .slice(0, 20);
  }

  private dirFor(id: string): string {
    return path.join(this.root, id);
  }

  async read<T>(id: string, name: string): Promise<T | null> {
    try {
      const raw = await readFile(path.join(this.dirFor(id), name), "utf8");
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async write(id: string, name: string, data: unknown): Promise<void> {
    await mkdir(this.dirFor(id), { recursive: true });
    await writeFile(path.join(this.dirFor(id), name), JSON.stringify(data));
  }
}

export interface CacheOpts {
  noCache?: boolean;
  debug?: (line: string) => void;
}

/** inspect() with read-through caching — expensive ffprobe runs once per
 * unchanged source. */
export async function cachedInspect(
  file: string,
  opts: CacheOpts = {},
): Promise<MediaInfo> {
  const cache = new Cache();
  const id = await cache.sourceId(file);
  if (!opts.noCache) {
    const hit = await cache.read<MediaInfo>(id, "metadata.json");
    if (hit) {
      opts.debug?.(`cache hit: metadata ${id}`);
      return hit;
    }
  }
  opts.debug?.(`cache miss: metadata ${id}`);
  const info = await inspectFile(file);
  if (!opts.noCache) await cache.write(id, "metadata.json", info);
  return info;
}
