import type { Database } from "bun:sqlite";

export interface ArbitrationTranscriptRow {
  id: string;
  room_id: string;
  participant_id: string;
  role: string;
  turn_index: number;
  content: string;
  tool_calls: string | null;
  created_at: number;
}

export class ArbitrationTranscriptsTable {
  constructor(private db: Database) {}

  insert(row: Omit<ArbitrationTranscriptRow, "id">): string {
    const id = crypto.randomUUID();
    this.db
      .query(
        `INSERT INTO arbitration_transcripts
         (id, room_id, participant_id, role, turn_index, content, tool_calls, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        row.room_id,
        row.participant_id,
        row.role,
        row.turn_index,
        row.content,
        row.tool_calls,
        row.created_at,
      );
    return id;
  }

  getById(id: string): ArbitrationTranscriptRow | null {
    return this.db
      .query("SELECT * FROM arbitration_transcripts WHERE id = ?")
      .get(id) as ArbitrationTranscriptRow | null;
  }

  listByRoom(
    roomId: string,
    opts: { limit?: number; offset?: number } = {},
  ): { items: ArbitrationTranscriptRow[]; total: number } {
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;
    const items = this.db
      .query(
        `SELECT * FROM arbitration_transcripts
         WHERE room_id = ?
         ORDER BY turn_index ASC, created_at ASC
         LIMIT ? OFFSET ?`,
      )
      .all(roomId, limit, offset) as ArbitrationTranscriptRow[];
    const total = (
      this.db
        .query("SELECT COUNT(*) AS c FROM arbitration_transcripts WHERE room_id = ?")
        .get(roomId) as { c: number }
    ).c;
    return { items, total };
  }
}
