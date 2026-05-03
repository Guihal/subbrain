/**
 * PR-B Phase B — cosine dedup for fresh rows (≤7d).
 * PR-B Phase C — legacy purge (JANITOR_LEGACY_SWEEP=true env flag).
 *
 * Both phases archive rows to layer3_archive (never DELETE — revertable).
 * Archive tag encodes source layer: "dedup-<date>,original_layer:<layer>"
 * or "legacy-cleanup-<date>,original_layer:<layer>".
 * Used by POST /v1/memory/restore to move rows back.
 */
import { randomUUID } from "crypto";
import type { MemoryDB } from "../../../db";
import type { RAGPipeline } from "../../../rag";
import { WHITELIST_SHARED, WHITELIST_CONTEXT, MAX_SHARED_CONTENT, MAX_CONTEXT_CONTENT } from "../../agent-pipeline/post/validators";
import { logger } from "../../../lib/logger";

const log = logger.child("night.janitor");

const DEDUP_THRESHOLD = () => {
  const v = parseFloat(process.env.JANITOR_DEDUP_THRESHOLD ?? "");
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : 0.92;
};
const FRESH_WINDOW_SEC = 7 * 86400;
const BATCH_DATE = new Date().toISOString().slice(0, 10);

export interface PhaseBCResult {
  dedupArchived: number;
  legacyArchived: number;
}

type LayerName = "shared" | "context";

interface RawRow {
  id: string;
  content: string;
  tags: string;
  category?: string;
  title?: string;
  created_at: number;
}

async function cosineSimilarity(
  rag: RAGPipeline,
  a: string,
  b: string,
): Promise<number> {
  const [va, vb] = await Promise.allSettled([
    rag.embedContent(a),
    rag.embedContent(b),
  ]);
  if (va.status !== "fulfilled" || vb.status !== "fulfilled") return 0;
  const A = va.value, B = vb.value;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < A.length; i++) {
    dot += A[i] * B[i]; na += A[i] ** 2; nb += B[i] ** 2;
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

function archiveRow(
  memory: MemoryDB,
  _srcTable: string,
  row: RawRow,
  layer: LayerName,
  tagPrefix: string,
): void {
  const arcTag = `${tagPrefix},original_layer:${layer}`;
  const title = (row as any).title ?? (row as any).category ?? "archived";
  memory.transaction(() => {
    memory.insertArchive(randomUUID(), title, row.content, arcTag, [], 0.5, "janitor");
    if (layer === "shared") memory.deleteShared(row.id);
    else memory.deleteContext(row.id);
  });
}

async function dedupLayer(
  memory: MemoryDB,
  rag: RAGPipeline,
  layer: LayerName,
  threshold: number,
): Promise<number> {
  const cutoff = Math.floor(Date.now() / 1000) - FRESH_WINDOW_SEC;
  const all = layer === "shared" ? memory.getAllShared() : memory.getAllContext();
  const rows = (all as RawRow[]).filter(r => r.created_at >= cutoff)
    .sort((a, b) => b.created_at - a.created_at);

  let archived = 0;
  const archived_ids = new Set<string>();

  for (let i = 0; i < rows.length; i++) {
    if (archived_ids.has(rows[i].id)) continue;
    for (let j = i + 1; j < rows.length; j++) {
      if (archived_ids.has(rows[j].id)) continue;
      const sim = await cosineSimilarity(rag, rows[i].content, rows[j].content);
      if (sim >= threshold) {
        // Keep newest (rows[i] — already sorted DESC by created_at), archive older
        archiveRow(memory, "", rows[j], layer, `dedup-${BATCH_DATE}`);
        archived_ids.add(rows[j].id);
        archived++;
      }
    }
  }
  return archived;
}

export async function runPhaseB(
  memory: MemoryDB,
  rag: RAGPipeline,
): Promise<{ dedupArchived: number }> {
  const threshold = DEDUP_THRESHOLD();
  const results = await Promise.allSettled([
    dedupLayer(memory, rag, "shared", threshold),
    dedupLayer(memory, rag, "context", threshold),
  ]);
  const dedupArchived = results.reduce(
    (sum, r) => sum + (r.status === "fulfilled" ? r.value : 0),
    0,
  );
  if (dedupArchived) {
    log.info(`phase-B dedup archived=${dedupArchived} threshold=${threshold}`);
  }
  return { dedupArchived };
}

export function runPhaseC(memory: MemoryDB): { legacyArchived: number } {
  if (process.env.JANITOR_LEGACY_SWEEP !== "true") {
    return { legacyArchived: 0 };
  }
  let legacyArchived = 0;
  const tag = `legacy-cleanup-${BATCH_DATE}`;

  // shared_memory: unknown category OR content too long
  for (const row of memory.getAllShared() as RawRow[]) {
    const unknownCat = !WHITELIST_SHARED.has((row.category ?? "").toLowerCase());
    const tooLong = row.content.length > MAX_SHARED_CONTENT;
    if (unknownCat || tooLong) {
      archiveRow(memory, "", row, "shared", tag);
      legacyArchived++;
    }
  }

  // layer2_context: check content length only (no category column)
  for (const row of memory.getAllContext() as RawRow[]) {
    if (row.content.length > MAX_CONTEXT_CONTENT) {
      archiveRow(memory, "", row, "context", tag);
      legacyArchived++;
    }
  }

  if (legacyArchived) {
    log.info(`phase-C legacy archived=${legacyArchived}`);
  }
  return { legacyArchived };
}
