import type { MemoryDB } from "@subbrain/core/db";
import { logger } from "@subbrain/core/lib/logger";
import type { ModelRouter } from "../../../lib/model-router";
import type { RAGPipeline } from "../../../rag";
import { parseJson } from "../types";

const log = logger.child("night");
const NIGHT_MODEL = process.env.NIGHT_CYCLE_MODEL || "memory";
const MAX_CONTEXT_ROWS = 500;
const MAX_ACTIONS = 30;
const MAX_DURATION_MS = 5 * 60 * 1000; // soft timeout; remaining rows next cycle
const MIN_MERGED = 15;

export async function pruneContext(
  memory: MemoryDB,
  router: ModelRouter,
  rag: RAGPipeline,
): Promise<number> {
  const all = memory.listContext(MAX_CONTEXT_ROWS, 0);
  if (all.length < 2) return 0;

  const startedAt = Date.now();
  const seen = new Set<string>();
  let pruned = 0;

  for (const row of all) {
    if (pruned >= MAX_ACTIONS) break;
    if (Date.now() - startedAt > MAX_DURATION_MS) {
      log.info(`prune_context: time cap reached, pruned=${pruned}`);
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
      .searchContext(tagTerms, 5)
      .filter((h) => h.id !== row.id && !seen.has(h.id));
    if (hits.length === 0) continue;

    const candidates = hits
      .map((h) => memory.getContext(h.id))
      .filter((x): x is NonNullable<typeof x> => x !== null);
    if (candidates.length === 0) continue;

    const agentLabel = (aid: string | null | undefined) => aid ?? "(none)";
    const listText = candidates
      .map(
        (c, i) =>
          `[${i + 1}] id=${c.id} agent=${agentLabel(c.agent_id)} title=${c.title}\n${c.content}`,
      )
      .join("\n\n");

    try {
      const response = await router.chat(
        NIGHT_MODEL,
        {
          messages: [
            { role: "system", content: CONTEXT_PROMPT },
            {
              role: "user",
              content: `## Запись\nid=${row.id} agent=${agentLabel(row.agent_id)} title=${row.title}\n${row.content}\n\n## Кандидаты\n${listText}`,
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
        memory.transaction(() => {
          memory.deleteContext(row.id);
          memory.deleteEmbedding(row.id);
        });
        pruned++;
        log.info(`prune_context:drop_self ${row.id.slice(0, 8)}`);
        continue;
      }

      const idx = typeof parsed.target === "number" ? parsed.target - 1 : -1;
      const target = idx >= 0 && idx < candidates.length ? candidates[idx] : null;

      if (parsed.action === "drop_target" && target && target.id !== row.id) {
        memory.transaction(() => {
          memory.deleteContext(target.id);
          memory.deleteEmbedding(target.id);
        });
        seen.add(target.id);
        pruned++;
        log.info(`prune_context:drop_target ${target.id.slice(0, 8)}`);
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
          memory.updateContext(target.id, { content: merged });
          memory.deleteContext(row.id);
          memory.deleteEmbedding(row.id);
        });
        seen.add(target.id);
        try {
          await rag.indexEntry(target.id, "context", merged);
        } catch {
          // best-effort; target keeps old embedding, next cycle re-tries
        }
        pruned++;
        log.info(`prune_context: merged ${row.id.slice(0, 8)} → ${target.id.slice(0, 8)}`);
      }
      // "keep" → no-op
    } catch (err) {
      log.warn(`prune_context: row=${row.id.slice(0, 8)} failed: ${(err as Error).message}`);
    }
  }

  return pruned;
}

const CONTEXT_PROMPT = `Ты чистишь layer2_context (проектные знания, контекст сессий). Сравни "запись" с FTS-кандидатами.

У каждой записи есть agent_id — владелец (или "(none)"). Разные agent'ы могут иметь приватные контексты; не мёрджи/дропай между разными agent'ами, если содержание не идентично по смыслу.

Actions:
- "keep"         — разные темы или разные agent'ы без реального overlap.
- "drop_self"    — кандидат уже содержит то же самое (и совместимый agent) → удалить ЗАПИСЬ.
- "drop_target"  — запись покрывает кандидата (кандидат устарел / уже) → удалить КАНДИДАТА.
- "merge"        — про одно с разными деталями, совместимые agent'ы → merge в кандидата, запись удалить.

Выводи JSON:
{"action": "keep" | "drop_self" | "drop_target" | "merge", "target": 1-based индекс кандидата или null, "mergedContent": "полный merged текст, только для merge"}

Правила:
- "target" обязателен для drop_target/merge. Для keep/drop_self — null.
- mergedContent только для merge, длина ≥ 15 символов.
- Сомневаешься → "keep". False-positive вреднее false-negative в памяти.`;
