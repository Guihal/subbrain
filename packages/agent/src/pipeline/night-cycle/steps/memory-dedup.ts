/**
 * MEM-6: night-cycle memory dedup orchestrator.
 *
 * Two passes per layer (shared, context):
 *   1. Cluster active+fresh rows by embedding similarity (cosine ≥ 0.9, same
 *      category) using sqlite-vec; pick the row with max(updated_at) as
 *      winner. Winner inherits longest content, union of tags + (for context)
 *      union of derived_from. Losers get superseded_by = winner.id.
 *   2. Mark every row whose expires_at has passed as superseded_by='expired'
 *      so RAG/pre stop showing it (data stays for audit; nothing is deleted).
 *
 * NOT named `dedup.ts` — that already exists for archive-layer dedup.
 *
 * Helpers (clustering + utils) live in memory-dedup-utils.ts.
 */
import type { ContextRow, MemoryDB, SharedRow } from "@subbrain/core/db";
import { logger } from "@subbrain/core/lib/logger";
import type { RAGPipeline } from "../../../rag";

import {
  activeContextRows,
  activeSharedRows,
  buildClusters,
  type Cluster,
  markExpired,
  parseDerivedFrom,
  unionCsv,
} from "./memory-dedup-utils";

const log = logger.child("night.memory-dedup");

interface DedupResult {
  shared: number;
  context: number;
  expired: number;
}

export async function runMemoryDedup(memory: MemoryDB, rag: RAGPipeline): Promise<DedupResult> {
  const sharedDeduped = await dedupSharedLayer(memory, rag);
  const contextDeduped = await dedupContextLayer(memory, rag);
  const expired = markExpired(memory);
  log.info(
    `done: shared deduped=${sharedDeduped}, context deduped=${contextDeduped}, expired=${expired}`,
  );
  return { shared: sharedDeduped, context: contextDeduped, expired };
}

async function dedupSharedLayer(memory: MemoryDB, rag: RAGPipeline): Promise<number> {
  const rows = activeSharedRows(memory);
  if (rows.length < 2) return 0;
  const clusters = await buildClusters(rows, rag, memory, "shared", (r) =>
    r.category.toLowerCase(),
  );
  return mergeSharedClusters(memory, clusters);
}

async function dedupContextLayer(memory: MemoryDB, rag: RAGPipeline): Promise<number> {
  const rows = activeContextRows(memory);
  if (rows.length < 2) return 0;
  const clusters = await buildClusters(rows, rag, memory, "context", (r) => r.title.toLowerCase());
  return mergeContextClusters(memory, clusters);
}

function mergeSharedClusters(memory: MemoryDB, clusters: Cluster[]): number {
  let merged = 0;
  for (const cluster of clusters) {
    const rows = cluster.ids
      .map((id) => memory.getShared(id))
      .filter((r): r is SharedRow => r !== null);
    if (rows.length < 2) continue;
    const winner = rows.reduce((a, b) => (b.updated_at > a.updated_at ? b : a));
    const longestContent = rows.reduce(
      (a, b) => (b.content.length > a.length ? b.content : a),
      winner.content,
    );
    const tags = unionCsv(rows.map((r) => r.tags));
    const conf = Math.max(...rows.map((r) => r.confidence ?? 0));
    memory.transaction(() => {
      memory.updateShared(winner.id, {
        content: longestContent,
        tags,
        confidence: conf,
      });
      for (const r of rows) {
        if (r.id === winner.id) continue;
        memory.updateShared(r.id, { superseded_by: winner.id });
        merged++;
      }
    });
  }
  return merged;
}

function mergeContextClusters(memory: MemoryDB, clusters: Cluster[]): number {
  let merged = 0;
  for (const cluster of clusters) {
    const rows = cluster.ids
      .map((id) => memory.getContext(id))
      .filter((r): r is ContextRow => r !== null);
    if (rows.length < 2) continue;
    const winner = rows.reduce((a, b) => (b.updated_at > a.updated_at ? b : a));
    const longestContent = rows.reduce(
      (a, b) => (b.content.length > a.length ? b.content : a),
      winner.content,
    );
    const tags = unionCsv(rows.map((r) => r.tags));
    const conf = Math.max(...rows.map((r) => r.confidence ?? 0));
    const derived = JSON.stringify([
      ...new Set(rows.flatMap((r) => parseDerivedFrom(r.derived_from))),
    ]);
    memory.transaction(() => {
      memory.updateContext(winner.id, {
        content: longestContent,
        tags,
        confidence: conf,
        derived_from: derived,
      });
      for (const r of rows) {
        if (r.id === winner.id) continue;
        memory.updateContext(r.id, { superseded_by: winner.id });
        merged++;
      }
    });
  }
  return merged;
}
