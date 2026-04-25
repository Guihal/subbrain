import type { MemoryDB } from "../../../db";
import type { ModelRouter } from "../../../lib/model-router";
import { logger } from "../../../lib/logger";
import { parseJson } from "../types";

const log = logger.child("night");
const NIGHT_MODEL = process.env.NIGHT_CYCLE_MODEL || "memory";
const MAX_ACTIONS = 30;
const MAX_DURATION_MS = 5 * 60 * 1000; // soft timeout; remaining rows next cycle
const MIN_MERGED = 15;

export async function pruneShared(
  memory: MemoryDB,
  router: ModelRouter,
): Promise<number> {
  const all = memory.getAllShared();
  if (all.length < 2) return 0;

  const startedAt = Date.now();
  const seen = new Set<string>();
  let pruned = 0;

  for (const row of all) {
    if (pruned >= MAX_ACTIONS) break;
    if (Date.now() - startedAt > MAX_DURATION_MS) {
      log.info(`prune_shared: time cap reached, pruned=${pruned}`);
      break;
    }
    if (seen.has(row.id)) continue;
    seen.add(row.id);

    const tagTerms = row.tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 3)
      .join(" OR ");
    if (!tagTerms) continue;

    const hits = memory
      .searchShared(tagTerms, 5)
      .filter((h) => h.id !== row.id && !seen.has(h.id));
    if (hits.length === 0) continue;

    const candidates = hits
      .map((h) => memory.getShared(h.id))
      .filter((x): x is NonNullable<typeof x> => x !== null);
    if (candidates.length === 0) continue;

    const listText = candidates
      .map((c, i) => `[${i + 1}] id=${c.id} cat=${c.category}\n${c.content}`)
      .join("\n\n");

    try {
      const response = await router.chat(
        NIGHT_MODEL,
        {
          messages: [
            { role: "system", content: SHARED_PROMPT },
            {
              role: "user",
              content: `## Запись\nid=${row.id} cat=${row.category}\n${row.content}\n\n## Кандидаты\n${listText}`,
            },
          ],
          max_tokens: 512,
          temperature: 0.1,
        },
        "low",
      );

      const parsed = parseJson(response.choices[0]?.message?.content || "");
      if (!parsed) continue;

      if (parsed.action === "drop_self") {
        memory.deleteShared(row.id);
        pruned++;
        log.info(`prune_shared:drop_self ${row.id.slice(0, 8)}`);
        continue;
      }

      const idx = typeof parsed.target === "number" ? parsed.target - 1 : -1;
      const target =
        idx >= 0 && idx < candidates.length ? candidates[idx] : null;

      if (
        parsed.action === "drop_target" &&
        target &&
        target.id !== row.id
      ) {
        memory.deleteShared(target.id);
        seen.add(target.id);
        pruned++;
        log.info(`prune_shared:drop_target ${target.id.slice(0, 8)}`);
        continue;
      }

      if (
        parsed.action === "merge" &&
        target &&
        target.id !== row.id &&
        typeof parsed.mergedContent === "string" &&
        parsed.mergedContent.trim().length >= MIN_MERGED
      ) {
        const merged = parsed.mergedContent.trim();
        memory.transaction(() => {
          memory.updateShared(target.id, { content: merged });
          memory.deleteShared(row.id);
        });
        seen.add(target.id);
        pruned++;
        log.info(
          `prune_shared: merged ${row.id.slice(0, 8)} → ${target.id.slice(0, 8)}`,
        );
      }
      // "keep" → no-op
    } catch (err) {
      log.warn(
        `prune_shared: row=${row.id.slice(0, 8)} failed: ${(err as Error).message}`,
      );
    }
  }

  return pruned;
}

const SHARED_PROMPT = `Ты чистишь shared_memory (факты о пользователе, инжектится в каждый системный промпт). Сравни "запись" с FTS-кандидатами (найдены по пересечению тегов).

Actions:
- "keep"         — запись и кандидаты про разные вещи, ничего не трогаем.
- "drop_self"    — кандидат N уже содержит то же; запись лишняя → удалить ЗАПИСЬ.
- "drop_target"  — запись покрывает кандидата N (устарел / ýже); удалить КАНДИДАТА N.
- "merge"        — про одно с разными деталями; слить в кандидата N, запись удалить.

Выводи JSON:
{"action": "keep" | "drop_self" | "drop_target" | "merge", "target": 1-based индекс кандидата или null, "mergedContent": "полный merged текст, только для merge"}

Правила:
- "target" обязателен для drop_target/merge. Для keep/drop_self — null.
- mergedContent только для merge, длина ≥ 15 символов.
- Сомневаешься → "keep". False-positive вреднее false-negative в памяти.`;
