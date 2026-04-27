/**
 * M-05 (mig 14): post-insert hook that draws `relates` edges to the top-3
 * vec neighbours in the same layer. Cap configurable via LINK_RELATED_TOP_N.
 * Non-blocking — RAG failure logs at warn and returns silently so the
 * calling write keeps its OK status.
 *
 * Self-skip: never link an inserted row to itself even if RAG surfaces it
 * (vector index is updated transactionally before this runs in some
 * call paths).
 *
 * M-05.1: A-MEM neighbour tag evolution. After each successful `linkEdge`,
 * call `evolveNeighbour` which merges `insertedTags` into the neighbour's
 * `tags` (CSV) — pure string-merge, no LLM, no schema change. Best-effort:
 * a throw is caught + warn-logged and never aborts `linkRelated`. Only
 * `tags` mutate; content / confidence / kind / status untouched.
 *
 * Env knobs (read at call-time per repo pattern):
 *   LINK_EVOLVE_TAGS_ENABLED  default "true" — disables the whole evolution
 *   LINK_EVOLVE_MAX_TAGS      default 10     — tail-truncate cap (drop oldest)
 */
import type { MemoryDB } from "../../../db";
import type { RAGPipeline } from "../../../rag";
import type { RequestLogger } from "../../../lib/logger";

export const LINK_RELATED_TOP_N = 3;

const MAX_TAGS_DEFAULT = 10;

function evolveEnabled(): boolean {
  const v = process.env.LINK_EVOLVE_TAGS_ENABLED;
  // Default true; only an explicit "false" (case-insensitive) disables.
  return v == null || v.toLowerCase() !== "false";
}

function maxTags(): number {
  const raw = process.env.LINK_EVOLVE_MAX_TAGS;
  if (!raw) return MAX_TAGS_DEFAULT;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : MAX_TAGS_DEFAULT;
}

/**
 * Exported sibling for `extractors.ts` — same logic as the module-private
 * `parseTags` below, just visible so callers don't reimplement the CSV
 * splitter. Returns [] for empty / whitespace-only input.
 */
export function parseTagsCsv(csv: string): string[] {
  if (!csv) return [];
  return csv
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

function parseTags(csv: string): string[] {
  return parseTagsCsv(csv);
}

function mergeUnique(a: string[], b: string[], cap: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of a) {
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  for (const t of b) {
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  // Tail-truncate: keep newest (drop from head) when over cap.
  return out.length > cap ? out.slice(out.length - cap) : out;
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = new Set(a);
  for (const t of b) if (!sa.has(t)) return false;
  return true;
}

function evolveNeighbour(
  memory: MemoryDB,
  neighbourId: string,
  neighbourLayer: "context" | "shared",
  insertedTags: string[],
  cap: number,
): void {
  if (insertedTags.length === 0) return;

  const row =
    neighbourLayer === "context"
      ? memory.getContext(neighbourId)
      : memory.getShared(neighbourId);
  if (!row) return; // deleted mid-flight — nothing to evolve.

  const currentTags = parseTags(row.tags ?? "");
  const merged = mergeUnique(currentTags, insertedTags, cap);
  if (sameSet(currentTags, merged)) return; // no-op: already covered.

  const newTagsCsv = merged.join(",");
  if (neighbourLayer === "context") {
    memory.updateContext(neighbourId, { tags: newTagsCsv });
  } else {
    memory.updateShared(neighbourId, { tags: newTagsCsv });
  }
}

export async function linkRelated(
  memory: MemoryDB,
  rag: RAGPipeline,
  insertedId: string,
  layer: "context" | "shared",
  content: string,
  insertedTags: string[],
  log: RequestLogger,
): Promise<void> {
  try {
    const neighbours = await rag.search({
      query: content,
      layers: [layer],
      rerankTopN: LINK_RELATED_TOP_N,
      skipRerank: true,
    });
    let drawn = 0;
    for (const n of neighbours) {
      if (drawn >= LINK_RELATED_TOP_N) break;
      if (n.id === insertedId) continue;
      try {
        // Edge weight is intentionally constant 1.0 in M-05: edges represent
        // existence of a relation, not strength. With `skipRerank: true` the
        // RAG result `score` is RRF-rank-derived (FTS+vec merge), not a
        // calibrated similarity — using it here would invert intuition for
        // downstream M-06 (reflect) / M-09 (cross-layer dedup) which read
        // higher weight as stronger relation. Strength is M-05.1 (evolution).
        memory.linkEdge(insertedId, layer, n.id, n.layer, "relates", 1.0);
        drawn++;
      } catch (err) {
        const em = err instanceof Error ? err.message : String(err);
        log.warn("post.extractors", `linkRelated edge insert failed: ${em}`);
        continue; // skip evolution if edge insert failed.
      }
      // M-05.1: best-effort neighbour tag evolution (non-blocking). RAG
      // search was scoped to `[layer]` above, so n.layer is guaranteed to
      // be the same context|shared as the inserted row — narrow the type
      // explicitly so TS doesn't see `string`.
      if (
        insertedTags.length > 0 &&
        evolveEnabled() &&
        (n.layer === "context" || n.layer === "shared")
      ) {
        try {
          evolveNeighbour(memory, n.id, n.layer, insertedTags, maxTags());
        } catch (err) {
          const em = err instanceof Error ? err.message : String(err);
          log.warn(
            "post.extractors",
            `evolveNeighbour failed for ${n.id}: ${em}`,
          );
        }
      }
    }
  } catch (err) {
    const em = err instanceof Error ? err.message : String(err);
    log.warn("post.extractors", `linkRelated failed for ${insertedId}: ${em}`);
  }
}
