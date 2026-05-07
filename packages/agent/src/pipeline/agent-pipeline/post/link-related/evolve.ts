/** M-05.1: tag-evolution helpers. See docs/completed/05-rag-pipeline.md. */
import type { MemoryDB } from "@subbrain/core/db";

const MAX_TAGS_DEFAULT = 10;

// Default true; only explicit "false" (case-insensitive) disables.
export const evolveEnabled = (): boolean =>
  process.env.LINK_EVOLVE_TAGS_ENABLED?.toLowerCase() !== "false";

export function maxTags(): number {
  const n = Number.parseInt(process.env.LINK_EVOLVE_MAX_TAGS ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : MAX_TAGS_DEFAULT;
}

/** Exported CSV splitter — caller-side use in `extractors.ts`. */
export function parseTagsCsv(csv: string): string[] {
  if (!csv) return [];
  return csv
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

export function mergeUnique(a: string[], b: string[], cap: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of [...a, ...b])
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  // Tail-truncate: drop oldest when over cap.
  return out.length > cap ? out.slice(out.length - cap) : out;
}

export function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = new Set(a);
  for (const t of b) if (!sa.has(t)) return false;
  return true;
}

export function evolveNeighbour(
  memory: MemoryDB,
  neighbourId: string,
  neighbourLayer: "context" | "shared",
  insertedTags: string[],
  cap: number,
): void {
  if (insertedTags.length === 0) return;
  const row =
    neighbourLayer === "context" ? memory.getContext(neighbourId) : memory.getShared(neighbourId);
  if (!row) return; // deleted mid-flight.
  const currentTags = parseTagsCsv(row.tags ?? "");
  const merged = mergeUnique(currentTags, insertedTags, cap);
  if (sameSet(currentTags, merged)) return; // already covered.
  const csv = merged.join(",");
  if (neighbourLayer === "context") memory.updateContext(neighbourId, { tags: csv });
  else memory.updateShared(neighbourId, { tags: csv });
}
