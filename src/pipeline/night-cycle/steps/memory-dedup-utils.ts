/**
 * MEM-6: helpers for memory-dedup.ts. Split out to keep the orchestrator
 * under the 250-LOC cap. Pure / small DB ops only — no external IO.
 */
import type { MemoryDB, SharedRow, ContextRow } from "../../../db";
import type { RAGPipeline } from "../../../rag";
import { logger } from "../../../lib/logger";

const log = logger.child("night.memory-dedup");

// Cosine threshold computed in JS. sqlite-vec returns L2 on un-normalised
// vectors, not cosine, so we use it only as a candidate filter and re-rank
// pairwise in JS using the vec map we already built.
export const DUP_COSINE_MIN = 0.90;
export const VEC_NEIGHBOURS = 5;
export const EMBED_BATCH_SIZE = 50;
export const EMBED_TIMEOUT_MS = 5000;

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

export interface Cluster {
  ids: string[];
}

export function activeSharedRows(memory: MemoryDB): SharedRow[] {
  const nowSec = Math.floor(Date.now() / 1000);
  return memory
    .getAllShared()
    .filter(
      (r) =>
        r.superseded_by === null &&
        r.status === "active" &&
        (r.expires_at === null || r.expires_at > nowSec),
    );
}

export function activeContextRows(memory: MemoryDB): ContextRow[] {
  const nowSec = Math.floor(Date.now() / 1000);
  const out: ContextRow[] = [];
  const PAGE = 200;
  for (let offset = 0; ; offset += PAGE) {
    const page = memory.listContext(PAGE, offset);
    for (const r of page) {
      if (r.superseded_by !== null) continue;
      if (r.status !== "active") continue;
      if (r.expires_at !== null && r.expires_at <= nowSec) continue;
      out.push(r);
    }
    if (page.length < PAGE) break;
  }
  return out;
}

export async function buildClusters<T extends { id: string; content: string }>(
  rows: T[],
  rag: RAGPipeline,
  memory: MemoryDB,
  layer: "shared" | "context",
  groupKey: (r: T) => string,
): Promise<Cluster[]> {
  const idToVec = new Map<string, Float32Array>();
  let skipped = 0;
  for (let i = 0; i < rows.length; i += EMBED_BATCH_SIZE) {
    const batch = rows.slice(i, i + EMBED_BATCH_SIZE);
    const settled = await Promise.allSettled(
      batch.map((r) =>
        rag.embedContent(r.content, AbortSignal.timeout(EMBED_TIMEOUT_MS)),
      ),
    );
    settled.forEach((res, idx) => {
      if (res.status === "fulfilled" && res.value && res.value.length > 0) {
        idToVec.set(batch[idx].id, res.value);
      } else {
        skipped++;
      }
    });
  }
  if (skipped > 0) {
    log.warn(
      `${layer}: ${skipped}/${rows.length} embeds failed; those rows skipped from dedup pass`,
    );
  }

  const parent = new Map<string, string>();
  const find = (x: string): string => {
    while (parent.get(x) !== x) {
      const p = parent.get(x)!;
      parent.set(x, parent.get(p)!);
      x = parent.get(x)!;
    }
    return x;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const r of rows) parent.set(r.id, r.id);

  const groupOf = new Map<string, string>(rows.map((r) => [r.id, groupKey(r)]));
  for (const r of rows) {
    const vec = idToVec.get(r.id);
    if (!vec) continue;
    // sqlite-vec gives us a candidate set ranked by L2 on un-normalised
    // vectors. We then re-rank in JS by cosine using the already-built
    // idToVec map — no extra embed calls.
    let neighbours;
    try {
      neighbours = memory.searchEmbeddings(vec, VEC_NEIGHBOURS, layer);
    } catch {
      continue;
    }
    for (const n of neighbours) {
      if (n.id === r.id) continue;
      if (groupOf.get(n.id) !== groupOf.get(r.id)) continue;
      const otherVec = idToVec.get(n.id);
      if (!otherVec) continue;
      if (cosineSimilarity(vec, otherVec) < DUP_COSINE_MIN) continue;
      union(r.id, n.id);
    }
  }

  const clusterMap = new Map<string, string[]>();
  for (const r of rows) {
    const root = find(r.id);
    if (!clusterMap.has(root)) clusterMap.set(root, []);
    clusterMap.get(root)!.push(r.id);
  }
  return [...clusterMap.values()]
    .filter((ids) => ids.length > 1)
    .map((ids) => ({ ids }));
}

export function unionCsv(parts: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    for (const raw of p.split(",")) {
      const t = raw.trim();
      if (!t) continue;
      const key = t.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
    }
  }
  return out.join(",");
}

export function parseDerivedFrom(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  } catch {
    // legacy / empty — ignore
  }
  return [];
}

export function markExpired(memory: MemoryDB): number {
  const nowSec = Math.floor(Date.now() / 1000);
  let count = 0;
  for (const r of memory.getAllShared()) {
    if (
      r.expires_at !== null &&
      r.expires_at <= nowSec &&
      r.superseded_by === null
    ) {
      memory.updateShared(r.id, { superseded_by: "expired" });
      count++;
    }
  }
  const PAGE = 200;
  for (let offset = 0; ; offset += PAGE) {
    const page = memory.listContext(PAGE, offset);
    for (const r of page) {
      if (
        r.expires_at !== null &&
        r.expires_at <= nowSec &&
        r.superseded_by === null
      ) {
        memory.updateContext(r.id, { superseded_by: "expired" });
        count++;
      }
    }
    if (page.length < PAGE) break;
  }
  return count;
}
