import type { Database } from "bun:sqlite";
import { AgentTasksTable } from "../db/tables/agent-tasks";
import type {
  AgentTaskArtifact,
  AgentTaskRecord,
  DistributionRow,
  EnqueueInput,
} from "../db/tables/agent-tasks/types";

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
    type: row.type as import("../db/tables/agent-tasks/types").AgentTaskType,
    prompt: row.prompt as string,
    status: row.status as import("../db/tables/agent-tasks/types").AgentTaskStatus,
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

export class AgentTasksRepository {
  private readonly table: AgentTasksTable;
  private readonly db: Database;

  constructor(db: Database) {
    this.table = new AgentTasksTable(db);
    this.db = db;
  }

  enqueue = (input: EnqueueInput): number => this.table.insertPending(input);

  claimNext = (now: number): AgentTaskRecord | null => this.table.claimNext(now);

  peekNextPending = (now: number): AgentTaskRecord | null => {
    const row = this.db
      .query(
        `SELECT * FROM agent_tasks WHERE status = 'pending'
         AND (scheduled_at IS NULL OR scheduled_at <= ?)
         ORDER BY priority DESC, scheduled_at, id LIMIT 1`,
      )
      .get(now) as Record<string, unknown> | null;
    return row ? mapRow(row) : null;
  };

  claim = (id: number, now: number): AgentTaskRecord | null => {
    const row = this.db
      .query(
        `UPDATE agent_tasks SET status = 'running', started_at = ?
         WHERE id = ? AND status = 'pending' RETURNING *`,
      )
      .get(now, id) as Record<string, unknown> | null;
    return row ? mapRow(row) : null;
  };

  listPending = (limit: number): AgentTaskRecord[] => this.table.listPending(limit);

  getRunningOlderThan = (cutoff: number): AgentTaskRecord[] =>
    this.table.getRunningOlderThan(cutoff);

  complete = (id: number, artifact: AgentTaskArtifact, now: number): void =>
    this.table.markComplete(id, artifact, now);

  noop = (id: number, reason: string, now: number): void => this.table.markNoop(id, reason, now);

  fail = (id: number, reason: string, now: number): void => this.table.markFailed(id, reason, now);

  markZombiesFailed = (cutoff: number): number => this.table.markZombiesFailed(cutoff);

  getDistribution24h = (now: number): DistributionRow[] =>
    this.table.getDistributionSince(now - 86400);

  countByPromptSnippet = (snippet: string, now: number): number =>
    this.table.countByPromptSnippet(snippet, now - 86400);

  getById = (id: number): AgentTaskRecord | null => this.table.getById(id);

  list = (opts: {
    status?: import("../db/tables/agent-tasks/types").AgentTaskStatus;
    type?: import("../db/tables/agent-tasks/types").AgentTaskType;
    limit: number;
    offset: number;
  }): { items: AgentTaskRecord[]; total: number } => this.table.list(opts);
}
