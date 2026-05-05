import type { Database } from "bun:sqlite";
import { type MetricsLogRow, MetricsTable } from "../db/tables/metrics";

export class MetricsRepository {
  private readonly table: MetricsTable;

  constructor(db: Database) {
    this.table = new MetricsTable(db);
  }

  listInRange(from: number, to: number): MetricsLogRow[] {
    return this.table.listInRange(from, to);
  }
}
