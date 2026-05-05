import { type MetricsState, WINDOW_MS } from "./types";

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

export function pruneSlidingWindows(state: MetricsState, now: number): void {
  const cutoff = now - WINDOW_MS;
  for (const [, counter] of state.byPriority) {
    while (counter.timestamps.length > 0 && counter.timestamps[0] <= cutoff) {
      counter.timestamps.shift();
    }
  }
  // Keep latencies for 5 minutes max (for percentile accuracy)
  const latencyCutoff = now - 5 * WINDOW_MS;
  while (state.latencies.length > 0 && state.latencies[0].ts <= latencyCutoff) {
    state.latencies.shift();
  }
}
