import type { Database } from "bun:sqlite";
import type {
  AgentTaskArtifact,
  AgentTaskRecord,
  DistributionRow,
  EnqueueInput,
} from "../db/tables/agent-tasks/types";
import { AgentTasksTable } from "../db/tables/agent-tasks";

export class AgentTasksRepository {
  private readonly table: AgentTasksTable;

  constructor(db: Database) {
    this.table = new AgentTasksTable(db);
  }

  enqueue = (input: EnqueueInput): number => this.table.insertPending(input);

  claimNext = (now: number): AgentTaskRecord | null => this.table.claimNext(now);

  listPending = (limit: number): AgentTaskRecord[] => this.table.listPending(limit);

  getRunningOlderThan = (cutoff: number): AgentTaskRecord[] =>
    this.table.getRunningOlderThan(cutoff);

  complete = (id: number, artifact: AgentTaskArtifact, now: number): void =>
    this.table.markComplete(id, artifact, now);

  noop = (id: number, reason: string, now: number): void =>
    this.table.markNoop(id, reason, now);

  fail = (id: number, reason: string, now: number): void =>
    this.table.markFailed(id, reason, now);

  markZombiesFailed = (cutoff: number): number => this.table.markZombiesFailed(cutoff);

  getDistribution24h = (now: number): DistributionRow[] =>
    this.table.getDistributionSince(now - 86400);

  countByPromptSnippet = (snippet: string, now: number): number =>
    this.table.countByPromptSnippet(snippet, now - 86400);

  getById = (id: number): AgentTaskRecord | null => this.table.getById(id);
}
