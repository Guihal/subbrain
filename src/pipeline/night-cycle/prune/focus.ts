import type { MemoryDB } from "../../../db";
import type { ModelRouter } from "../../../lib/model-router";
import { logger } from "../../../lib/logger";
import { parseJson } from "../types";

const log = logger.child("night");
const NIGHT_MODEL = process.env.NIGHT_CYCLE_MODEL || "coder";

/**
 * Focus keys owned by system subsystems — never pruned. User/agent keys
 * (from /v1/memory/focus or hippocampus memory_write) are fair game.
 *
 * Audit 2026-04-22 via `grep -rn "setFocus\\|getFocus" src/`:
 *   night_cycle_last_processed_id — src/pipeline/night-cycle/types.ts:26, index.ts:59,192
 *   tg.poller.last_id             — src/scheduler/telegram-poller.ts:24,101,129
 *   tasks.state                   — src/scheduler/telegram-poller.ts:23,178,196
 * Extend when a new scheduler stores state in layer1_focus.
 */
const PROTECTED_FOCUS_KEYS = new Set<string>([
  "night_cycle_last_processed_id",
  "tasks.state",
  "tg.poller.last_id",
  "night.stray_tasks.last_run_at",
]);

export async function pruneFocus(
  memory: MemoryDB,
  router: ModelRouter,
): Promise<number> {
  const all = memory.getAllFocus();
  const editable = Object.entries(all).filter(
    ([k]) => !PROTECTED_FOCUS_KEYS.has(k),
  );
  if (editable.length < 2) return 0;

  const kvList = editable
    .map(([k, v], i) => `[${i + 1}] ${k}: ${v}`)
    .join("\n");

  let response;
  try {
    response = await router.chat(
      NIGHT_MODEL,
      {
        messages: [
          { role: "system", content: FOCUS_PROMPT },
          { role: "user", content: kvList },
        ],
        max_tokens: 1024,
        temperature: 0.1,
      },
      "low",
    );
  } catch (err) {
    log.warn(`prune_focus: llm failed: ${(err as Error).message}`);
    return 0;
  }

  const parsed = parseJson(response.choices[0]?.message?.content || "");
  if (!parsed || !Array.isArray(parsed.actions)) return 0;

  // Once a key participates in any successful action (keepKey / dropKeys /
  // drop-op key), it is locked from further actions. Protects against LLM
  // returning two merges on the same keepKey (data loss), or merge→drop /
  // drop→merge overlap.
  const touched = new Set<string>();
  let pruned = 0;

  for (const a of parsed.actions) {
    try {
      if (
        a?.op === "drop" &&
        typeof a.key === "string" &&
        !PROTECTED_FOCUS_KEYS.has(a.key) &&
        !touched.has(a.key) &&
        all[a.key] !== undefined
      ) {
        memory.deleteFocus(a.key);
        touched.add(a.key);
        pruned++;
        log.info(`prune_focus:drop key=${a.key}`);
        continue;
      }
      if (
        a?.op === "merge" &&
        typeof a.keepKey === "string" &&
        Array.isArray(a.dropKeys) &&
        typeof a.mergedValue === "string" &&
        a.mergedValue.trim().length > 0 &&
        !PROTECTED_FOCUS_KEYS.has(a.keepKey) &&
        !touched.has(a.keepKey) &&
        all[a.keepKey] !== undefined
      ) {
        const merged = a.mergedValue.trim();
        const drops: string[] = a.dropKeys.filter(
          (dk: unknown): dk is string =>
            typeof dk === "string" &&
            dk !== a.keepKey &&
            !PROTECTED_FOCUS_KEYS.has(dk) &&
            !touched.has(dk) &&
            all[dk] !== undefined,
        );
        memory.db.transaction(() => {
          memory.setFocus(a.keepKey, merged);
          for (const dk of drops) memory.deleteFocus(dk);
        })();
        touched.add(a.keepKey);
        for (const dk of drops) touched.add(dk);
        pruned += drops.length;
        log.info(
          `prune_focus: merge keep=${a.keepKey} dropped=${drops.length}`,
        );
      }
    } catch (err) {
      log.warn(`prune_focus: action failed: ${(err as Error).message}`);
    }
  }
  return pruned;
}

const FOCUS_PROMPT = `Ты чистишь layer1_focus — KV-store, инжектится в КАЖДЫЙ системный промпт. Только актуальные директивы / состояние. Устаревшее, тривиальное, противоречивое — удалять.

Ввод: "[i] key: value" per line.

Actions:
- "drop":  value устарел, пустой/тривиальный, или противоречит более свежему key.
- "merge": несколько ключей про одно → merged в keepKey, dropKeys удаляются.

Выводи JSON:
{ "actions": [ {"op": "drop", "key": "..."} | {"op": "merge", "keepKey": "...", "dropKeys": ["..."], "mergedValue": "..."} ] }

Примеры:
- Нечего чистить: {"actions": []}
- Слияние: {"actions":[{"op":"merge","keepKey":"project.goal","dropKeys":["task.current"],"mergedValue":"Finish X — current Y"}]}
- Удаление устаревшего: {"actions":[{"op":"drop","key":"reminder.done_last_week"}]}

Правила:
- Сомневаешься — не трогай.
- mergedValue не пустой (trim ≥ 1 символ).
- Один keepKey — максимум в ОДНОЙ merge-action.`;
