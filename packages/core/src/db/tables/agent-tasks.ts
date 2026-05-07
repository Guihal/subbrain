import type { Database } from "bun:sqlite";
import type {
  AgentTaskArtifact,
  AgentTaskRecord,
  AgentTaskStatus,
  AgentTaskType,
  DistributionRow,
  EnqueueInput,
} from "./agent-tasks/types";

function mapRow(row: Record<string, unknown>): AgentTaskRecord {
  let artifact: AgentTaskArtifact | null = null;
  if (row.artifact) {
    try {
      artifact = JSON.parse(row.artifact as string) as AgentTaskArtifact;
    } catch {
      artifact = null;
    }
  }
  return {
    id: row.id as number,
    type: row.type as AgentTaskType,
    prompt: row.prompt as string,
    status: row.status as AgentTaskStatus,
    priority: row.priority as number,
    scheduledAt: row.scheduled_at == null ? null : (row.scheduled_at as number),
    startedAt: row.started_at == null ? null : (row.started_at as number),
    finishedAt: row.finished_at == null ? null : (row.finished_at as number),
    artifact,
    reason: row.reason == null ? null : (row.reason as string),
    createdBy: row.created_by as string,
    createdAt: row.created_at as number,
  };
}

export class AgentTasksTable {
  constructor(private db: Database) {}

  insertPending(input: EnqueueInput): number {
    const result = this.db
      .query(
        `INSERT INTO agent_tasks (type, prompt, priority, scheduled_at, created_by)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        input.type,
        input.prompt,
        input.priority ?? 0,
        input.scheduledAt ?? null,
        input.createdBy,
      );
    return Number(result.lastInsertRowid);
  }

  claimNext(now: number): AgentTaskRecord | null {
    const row = this.db
      .query(
        `UPDATE agent_tasks SET status = 'running', started_at = ?
          WHERE id = (SELECT id FROM agent_tasks WHERE status = 'pending'
                       AND (scheduled_at IS NULL OR scheduled_at <= ?)
                     ORDER BY priority DESC, scheduled_at, id LIMIT 1)
        RETURNING *`,
      )
      .get(now, now) as Record<string, unknown> | null;
    return row ? mapRow(row) : null;
  }

  listPending(limit: number): AgentTaskRecord[] {
    const rows = this.db
      .query(
        `SELECT * FROM agent_tasks WHERE status = 'pending'
         ORDER BY priority DESC, scheduled_at, id LIMIT ?`,
      )
      .all(limit) as Record<string, unknown>[];
    return rows.map(mapRow);
  }

  getRunningOlderThan(cutoff: number): AgentTaskRecord[] {
    const rows = this.db
      .query(`SELECT * FROM agent_tasks WHERE status = 'running' AND started_at < ?`)
      .all(cutoff) as Record<string, unknown>[];
    return rows.map(mapRow);
  }

  markRunning(id: number, now: number): void {
    this.db
      .query(`UPDATE agent_tasks SET status = 'running', started_at = ? WHERE id = ?`)
      .run(now, id);
  }

  markComplete(id: number, artifact: AgentTaskArtifact, now: number): void {
    this.db
      .query(`UPDATE agent_tasks SET status = 'done', finished_at = ?, artifact = ? WHERE id = ?`)
      .run(now, JSON.stringify(artifact), id);
  }

  markNoop(id: number, reason: string, now: number): void {
    this.db
      .query(`UPDATE agent_tasks SET status = 'noop', finished_at = ?, reason = ? WHERE id = ?`)
      .run(now, reason, id);
  }

  markFailed(id: number, reason: string, now: number): void {
    this.db
      .query(`UPDATE agent_tasks SET status = 'failed', finished_at = ?, reason = ? WHERE id = ?`)
      .run(now, reason, id);
  }

  markZombiesFailed(cutoff: number): number {
    return this.db
      .query(
        `UPDATE agent_tasks SET status = 'failed', finished_at = ?, reason = 'zombie_timeout'
          WHERE status = 'running' AND started_at < ?`,
      )
      .run(cutoff, cutoff).changes;
  }

  getDistributionSince(cutoff: number): DistributionRow[] {
    return this.db
      .query(
        `SELECT type, status, COUNT(*) AS count FROM agent_tasks
          WHERE finished_at >= ? AND status IN ('done','noop','failed')
          GROUP BY type, status`,
      )
      .all(cutoff) as DistributionRow[];
  }

  countByPromptSnippet(snippet: string, cutoff: number): number {
    const row = this.db
      .query(`SELECT COUNT(*) AS c FROM agent_tasks WHERE prompt LIKE ? AND created_at >= ?`)
      .get(`%${snippet}%`, cutoff) as { c: number } | null;
    return row?.c ?? 0;
  }

  getById(id: number): AgentTaskRecord | null {
    const row = this.db.query(`SELECT * FROM agent_tasks WHERE id = ?`).get(id) as Record<
      string,
      unknown
    > | null;
    return row ? mapRow(row) : null;
  }

  list(opts: { status?: AgentTaskStatus; type?: AgentTaskType; limit: number; offset: number }): {
    items: AgentTaskRecord[];
    total: number;
  } {
    const conds: string[] = [],
      params: (string | number)[] = [];
    if (opts.status) {
      conds.push("status = ?");
      params.push(opts.status);
    }
    if (opts.type) {
      conds.push("type = ?");
      params.push(opts.type);
    }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const countRow = this.db
      .query(`SELECT COUNT(*) AS c FROM agent_tasks ${where}`)
      .get(...params) as { c: number } | null;
    const items = (
      this.db
        .query(
          `SELECT * FROM agent_tasks ${where} ORDER BY priority DESC, created_at DESC LIMIT ? OFFSET ?`,
        )
        .all(...params, opts.limit, opts.offset) as Record<string, unknown>[]
    ).map(mapRow);
    return { items, total: countRow?.c ?? 0 };
  }
}
