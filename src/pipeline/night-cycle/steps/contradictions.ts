import type { MemoryDB } from "@subbrain/core/db";
import type { ModelRouter } from "../../../lib/model-router";
import type { RAGPipeline } from "../../../rag";
import { parseJson } from "../types";
import { nightLog as log, NIGHT_MODEL } from "./shared";

export async function resolveContradictions(
  memory: MemoryDB,
  router: ModelRouter,
  rag?: RAGPipeline,
): Promise<number> {
  // M-12 (mig 15): confidence unified to REAL [0..1]. Pre-mig 15 'LOW' rows
  // backfilled to 0.4 → threshold < MEMORY_AUTOACCEPT_CONFIDENCE 0.8 selects
  // exactly the same set; new writers (verify step) drop confidence to 0.4.
  const lowConfidence = memory.db
    .query(
      "SELECT id, title, content FROM layer3_archive WHERE confidence IS NOT NULL AND confidence < 0.8 ORDER BY created_at DESC LIMIT 10",
    )
    .all() as { id: string; title: string; content: string }[];

  if (lowConfidence.length === 0) return 0;
  let resolved = 0;

  for (const entry of lowConfidence) {
    try {
      const related = memory.searchArchive(entry.title, 3);
      if (related.length === 0) {
        memory.updateArchive(entry.id, { confidence: 0.9 });
        resolved++;
        continue;
      }

      const relatedSummary = related.map((r) => `${r.title}: ${r.snippet}`).join("\n");

      const response = await router.chat(
        NIGHT_MODEL,
        {
          messages: [
            {
              role: "system",
              content: `Compare the flagged entry with related entries. Determine if there's a contradiction.

Output JSON:
{
  "hasContradiction": true/false,
  "resolution": "keep_new" | "keep_old" | "merge",
  "mergedContent": "only if resolution=merge"
}`,
            },
            {
              role: "user",
              content: `## Flagged entry\n${entry.title}: ${entry.content}\n\n## Related entries\n${relatedSummary}`,
            },
          ],
          max_tokens: 512,
          temperature: 0.1,
        },
        "low",
      );

      const raw = response.choices[0]?.message?.content || "";
      const parsed = parseJson(raw);
      if (!parsed) continue;

      if (!parsed.hasContradiction) {
        memory.updateArchive(entry.id, { confidence: 0.9 });
        resolved++;
      } else if (parsed.resolution === "keep_new") {
        memory.updateArchive(entry.id, { confidence: 0.9 });
        resolved++;
      } else if (parsed.resolution === "keep_old") {
        // M-4: drop vec row in the same transaction so dedup-resolution
        // doesn't leave an orphan in vec_embeddings (which would still be
        // returned by vecSearch and then silently filtered at hydrate).
        memory.transaction(() => {
          memory.deleteArchive(entry.id);
          memory.deleteEmbedding(entry.id);
        });
        resolved++;
      } else if (parsed.resolution === "merge" && parsed.mergedContent) {
        memory.updateArchive(entry.id, {
          content: parsed.mergedContent,
          confidence: 0.9,
        });
        if (rag) {
          try {
            await rag.indexEntry(entry.id, "archive", parsed.mergedContent);
          } catch (err) {
            log.warn(`resolveContradictions: reindex failed — ${(err as Error).message}`);
          }
        }
        resolved++;
      }
    } catch (err) {
      log.warn(`resolveContradictions: entry=${entry.id.slice(0, 8)} ${(err as Error).message}`);
    }
  }

  return resolved;
}
