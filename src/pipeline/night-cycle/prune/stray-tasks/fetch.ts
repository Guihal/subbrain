/**
 * Window scan: pull task-tagged rows from `shared_memory` + `layer2_context`
 * created after `windowStart`, drop blacklisted/completed entries, and shape
 * them into the `CandidateRow` contract consumed by `./classify.ts`.
 *
 * Pure data layer — no LLM calls, no writes.
 */
import type { MemoryDB } from "../../../../db";
import {
  type CandidateRow,
  hasBlacklistTag,
  hasCompletedStatusTag,
  hasTaskTag,
} from "../tasks-classify";

interface SharedScanRow {
  id: string;
  category: string;
  content: string;
  tags: string;
}

interface ContextScanRow {
  id: string;
  title: string;
  content: string;
  tags: string;
  agent_id: string | null;
}

export function fetchCandidates(memory: MemoryDB, windowStart: number): CandidateRow[] {
  const candidates: CandidateRow[] = [];
  const shared = memory.db
    .query(
      `SELECT id, category, content, tags FROM shared_memory
       WHERE created_at >= ?`,
    )
    .all(windowStart) as SharedScanRow[];
  for (const row of shared) {
    if (!hasTaskTag(row.tags)) continue;
    if (hasBlacklistTag(row.tags)) continue;
    if (hasCompletedStatusTag(row.tags)) continue;
    candidates.push({
      id: row.id,
      source_table: "shared_memory",
      content: row.content,
      tags: row.tags,
      category: row.category,
    });
  }
  const context = memory.db
    .query(
      `SELECT id, title, content, tags, agent_id FROM layer2_context
       WHERE created_at >= ?`,
    )
    .all(windowStart) as ContextScanRow[];
  for (const row of context) {
    if (!hasTaskTag(row.tags)) continue;
    if (hasBlacklistTag(row.tags)) continue;
    if (hasCompletedStatusTag(row.tags)) continue;
    candidates.push({
      id: row.id,
      source_table: "layer2_context",
      content: row.content,
      tags: row.tags,
      title: row.title,
      agent_id: row.agent_id,
    });
  }
  return candidates;
}
