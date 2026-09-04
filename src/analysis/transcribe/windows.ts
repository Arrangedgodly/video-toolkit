/** Window planning for engines that transcribe whole files without
 * timestamps: we cut the audio ourselves, so every segment's time range is
 * exact by construction, and boundaries can snap to nearby silence so words
 * are not split mid-phrase. */

export interface Window {
  start: number;
  end: number;
}

const MIN_WINDOW = 0.5;
const MIN_SEPARATION = 1.0;

export function planWindows(
  duration: number,
  chunkSeconds: number,
  silences: { start: number; end: number }[] = [],
): Window[] {
  if (duration <= 0) return [];
  const chunk = Math.max(2, chunkSeconds);
  const snapRadius = chunk / 3;

  const boundaries: number[] = [];
  for (let t = chunk; t < duration - MIN_WINDOW; t += chunk) {
    const ideal = t;
    let best: number = ideal;
    let bestDist = snapRadius + 1;
    for (const s of silences) {
      const mid = (s.start + s.end) / 2;
      const dist = Math.abs(mid - ideal);
      if (dist < bestDist) {
        best = mid;
        bestDist = dist;
      }
    }
    const prev = boundaries[boundaries.length - 1] ?? 0;
    if (best - prev < MIN_SEPARATION || duration - best < MIN_WINDOW) continue;
    boundaries.push(best);
  }

  const windows: Window[] = [];
  let cur = 0;
  for (const b of boundaries) {
    windows.push({ start: cur, end: b });
    cur = b;
  }
  windows.push({ start: cur, end: duration });
  return windows;
}
