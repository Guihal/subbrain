/**
 * ArbitrationTranscriptRepository — P6-3 (LAYER-5).
 * Wraps ArbitrationTranscriptsTable. SQL only, no business logic.
 */
import type { Database } from "bun:sqlite";
import type { ArbitrationTranscriptRow } from "../db/tables/arbitration-transcripts";
import { ArbitrationTranscriptsTable } from "../db/tables/arbitration-transcripts";

export class ArbitrationTranscriptRepository {
  private readonly table: ArbitrationTranscriptsTable;

  constructor(db: Database) {
    this.table = new ArbitrationTranscriptsTable(db);
  }

  insert = (row: Omit<ArbitrationTranscriptRow, "id">): string =>
    this.table.insert(row);

  getById = (id: string): ArbitrationTranscriptRow | null =>
    this.table.getById(id);

  listByRoom = (
    roomId: string,
    opts?: { limit?: number; offset?: number },
  ): { items: ArbitrationTranscriptRow[]; total: number } =>
    this.table.listByRoom(roomId, opts);
}
