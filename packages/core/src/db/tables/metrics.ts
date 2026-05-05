import type { Database } from "bun:sqlite";

export interface MetricsLogRow {
  timestamp: number;
  snapshot: string;
}

export class MetricsTable {
  constructor(public readonly db: Database) {}

  listInRange(from: number, to: number): MetricsLogRow[] {
    return this.db
      .query<MetricsLogRow, [number, number]>(
        "SELECT timestamp, snapshot FROM metrics_log WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp",
      )
      .all(from, to);
  }
}
