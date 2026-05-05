import type { MemoryDB } from "@subbrain/core/db";
import type { ModelRouter } from "@subbrain/core/lib/model-router";
import type { RAGPipeline } from "../../../rag";
import type { CompressedEntry } from "../types";
import { parseJson } from "../types";
import { nightLog as log, NIGHT_MODEL } from "./shared";

export async function dedup(
  entry: CompressedEntry,
  memory: MemoryDB,
  router: ModelRouter,
  rag?: RAGPipeline,
): Promise<boolean> {
  try {
    const existing = memory.searchArchive(entry.tags.split(",").slice(0, 3).join(" OR "), 5);

    if (existing.length === 0) return false;

    const existingSummary = existing.map((e) => `[${e.id}] ${e.title}: ${e.snippet}`).join("\n");

    const response = await router.chat(
      NIGHT_MODEL,
      {
        messages: [
          {
            role: "system",
            content: `Ты сравниваешь новую запись с existing archive entries, которые найдены по пересечению тегов (FTS OR-search по top-3 тегов новой записи).

Вывод JSON:
{
  "isDuplicate": true/false,
  "duplicateOf": "id дубликата или null",
  "action": "skip" | "merge" | "append"
}

Actions:
- **skip**: новая ПОЛНОСТЬЮ перекрывается existing по теме и содержанию. Теги «python,scripting» — новая «Python — скриптовый язык», existing «Python — динамический язык для scripting и ML». Новая ничего не добавляет.
- **merge**: общие теги + новая добавляет детали по той же теме. Теги «nuxt,vue» — новая «Nuxt 3 получил Vapor mode», existing «Nuxt 3 — SSR фреймворк на Vue 3». Верни \`duplicateOf\` = id existing.
- **append**: теги пересекаются, но тема реально другая. Теги «python,ml» — новая «PyTorch лучше TensorFlow для RL», existing «Python как язык программирования».`,
          },
          {
            role: "user",
            content: `## New entry\nTitle: ${entry.title}\n${entry.content}\n\n## Existing entries\n${existingSummary}`,
          },
        ],
        max_tokens: 256,
        temperature: 0.1,
      },
      "low",
    );

    const raw = response.choices[0]?.message?.content || "";
    const parsed = parseJson(raw);
    if (!parsed) return false;

    if (parsed.action === "skip") return true;

    if (parsed.action === "merge" && parsed.duplicateOf) {
      memory.updateArchive(parsed.duplicateOf, {
        content: entry.content,
        tags: entry.tags,
      });
      // Re-index: merged content must be searchable by its new vector.
      if (rag) {
        try {
          await rag.indexEntry(parsed.duplicateOf, "archive", entry.content);
        } catch (err) {
          log.warn(`dedup: reindex failed — ${(err as Error).message}`);
        }
      }
      return true;
    }

    return false;
  } catch (err) {
    log.warn(`dedup: ${(err as Error).message}`);
    return false;
  }
}
