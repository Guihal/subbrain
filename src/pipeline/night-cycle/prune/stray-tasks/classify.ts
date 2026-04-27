/**
 * Per-row LLM-classify + (idempotent) migrate loop. Honours `MAX_PER_CYCLE`
 * and `MAX_DURATION_MS`; any cap-hit signals back to the caller via the
 * returned `capHit` so the orchestrator can refuse to advance the focus key
 * (skipped tail will be re-scanned next cycle).
 */
import { randomUUID } from "crypto";
import type { MemoryDB } from "../../../../db";
import { logger } from "../../../../lib/logger";
import {
  type CandidateRow,
  type Classifier,
  classifyCandidate,
} from "../tasks-classify";
import { MAX_DURATION_MS, MAX_PER_CYCLE } from "./constants";

const log = logger.child("night.stray");

export interface ClassifyAndUpsertResult {
  migrated: number;
  capHit: boolean;
}

export async function classifyAndUpsert(
  memory: MemoryDB,
  router: Classifier,
  candidates: CandidateRow[],
): Promise<ClassifyAndUpsertResult> {
  const startedAt = Date.now();
  let migrated = 0;
  let processed = 0;
  let capHit = false;

  for (const row of candidates) {
    if (processed >= MAX_PER_CYCLE) {
      capHit = true;
      break;
    }
    if (Date.now() - startedAt > MAX_DURATION_MS) {
      log.info(`time cap reached, migrated=${migrated}`);
      capHit = true;
      break;
    }
    processed += 1;

    let result;
    try {
      result = await classifyCandidate(router, row);
    } catch (err) {
      log.warn(
        `classify row=${row.id.slice(0, 8)} failed: ${(err as Error).message}`,
      );
      continue;
    }
    if (!result || result.action !== "migrate") continue;

    try {
      memory.transaction(() => {
        memory.upsertTaskBySource(
          `stray:${row.source_table}:${row.id}`,
          {
            scope: result.scope,
            title: result.title,
            description: result.description,
            priority: result.priority,
          },
          randomUUID(),
        );
        if (row.source_table === "shared_memory") {
          memory.deleteShared(row.id);
        } else {
          memory.deleteContext(row.id);
          memory.deleteEmbedding(row.id);
        }
      });
      migrated += 1;
      log.info(
        `migrated ${row.source_table}:${row.id.slice(0, 8)} scope=${result.scope}`,
      );
    } catch (err) {
      log.warn(
        `tx row=${row.id.slice(0, 8)} failed: ${(err as Error).message}`,
      );
    }
  }

  return { migrated, capHit };
}
