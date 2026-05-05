/**
 * Simple named counters for spec-required telemetry.
 * In-memory; future: expose via /metrics or drain to DB.
 */

type Labels = Record<string, string>;

const _counters = new Map<string, number>();

/**
 * Increment a named counter with optional labels.
 * Name format: `metric_name{key="value",...}` (Prometheus-style for future wiring).
 */
export function incrementCounter(name: string, labels?: Labels): void {
  const key =
    labels && Object.keys(labels).length > 0
      ? `${name}{${Object.entries(labels)
          .map(([k, v]) => `${k}="${v}"`)
          .join(",")}}`
      : name;
  _counters.set(key, (_counters.get(key) ?? 0) + 1);
}

/** Read all counters — used in tests and /metrics endpoint. */
export function getCounters(): Map<string, number> {
  return new Map(_counters);
}

/** Reset all counters (test use only). */
export function resetCounters(): void {
  _counters.clear();
}
