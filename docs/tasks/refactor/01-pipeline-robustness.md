# Задача 01 — Pipeline robustness (HIGH-2/3/5/6)

**Оценка:** 1 день
**Зависимости:** —
**Status:** DONE

## Цель

Закрыть четыре бага, из-за которых pipeline либо теряет ответы, либо тихо калечит БД. Всё — изменения поведения в точечных местах, без рефакторинга структуры.

## Пункты

### HIGH-2 — `arbitration-room.ts`: `Promise.all` → `Promise.allSettled` + abort остальных

**Файл:** [packages/agent/src/pipeline/arbitration/index.ts](../../../packages/agent/src/pipeline/arbitration/index.ts)

- `Promise.all` над N специалистами → один падает → падает арбитраж целиком. Заменить на `allSettled`, пропустить упавших.
- Первый `fulfilled` → `AbortController.abort()` на остальных; сигнал пробрасывается в `ModelRouter.chat()` и далее в провайдеры.
- Провайдеры ([packages/providers/src/nvidia.ts](../../../packages/providers/src/nvidia.ts), [packages/providers/src/nvidia.ts](../../../packages/providers/src/nvidia.ts)) проверяют `signal.aborted` перед стартом `fetch` и в SSE-callback.
- `ModelRouter.chat()` принимает `{ signal?: AbortSignal }` и прокидывает в провайдер.

**Тест:** `tests/arbitration.test.ts` — моковый провайдер, который кидает на 2-м шаге; арбитраж возвращает результат от оставшихся N-1.

### HIGH-3 — per-tool timeout в `agent-loop/tool-runner.ts`

**Файл:** [packages/agent/src/pipeline/agent-loop/tool-runner.ts](../../../packages/agent/src/pipeline/agent-loop/tool-runner.ts)

- `Promise.race([exec, timeoutPromise(N)])` вокруг каждого `handler.call`.
- N по scope:
  - `web_*` → 15000 ms
  - `memory_*` → 3000 ms
  - `embed_*` → 5000 ms
  - `consult_*` → 20000 ms
  - остальное → 5000 ms
- Таймаут **не кидает** — попадает в `tool_result` как `ToolError{code:"timeout", name}`. Модель решает, повторять или идти дальше.

**Тест:** `tests/tool-runner.test.ts` — мок-handler с `await new Promise(r => setTimeout(r, 10000))` для `memory_search` → получаем `ToolError{code:"timeout"}` за ≤ 3.5s.

### HIGH-5 — FTS-санитизация тегов в night-cycle

**Файл:** [packages/agent/src/pipeline/night-cycle/steps.ts](../../../packages/agent/src/pipeline/night-cycle/steps.ts), строка ~187

- Теги (user-supplied, могут содержать `"`, `:`, `*`) напрямую идут в `MATCH` → throw.
- Прогнать через `sanitizeFtsQuery` из [packages/core/src/lib/fts-utils.ts](../../../packages/core/src/lib/fts-utils.ts).

**Тест:** `tests/night-cycle.test.ts` — подсунуть тег `tag"with:quote*` → step отрабатывает без exception.

### HIGH-6 — транзакция insertArchive + indexEntry

**Файл:** [packages/agent/src/pipeline/night-cycle/index.ts](../../../packages/agent/src/pipeline/night-cycle/index.ts), строки 86-101

- Сейчас: `insertArchive()` коммитится, затем `rag.indexEntry()` падает на эмбеддинге → архив с `NULL`-вектором навсегда невидим для RAG.
- Обернуть в `db.transaction(() => { insertArchive(); rag.indexEntry(); })`. Фейл эмбеддинга → откат, `logger.warn("night-cycle", "archive_retry_next_cycle", {id})`, retry следующей ночью.

**Тест:** `tests/night-cycle.test.ts` — мок `rag.indexEntry` кидает один раз → в БД нет записи; второй прогон с работающим rag → запись есть.

## Файлы

- [packages/agent/src/pipeline/arbitration/index.ts](../../../packages/agent/src/pipeline/arbitration/index.ts)
- [packages/agent/src/pipeline/agent-loop/tool-runner.ts](../../../packages/agent/src/pipeline/agent-loop/tool-runner.ts)
- [packages/agent/src/pipeline/night-cycle/steps.ts](../../../packages/agent/src/pipeline/night-cycle/steps.ts)
- [packages/agent/src/pipeline/night-cycle/index.ts](../../../packages/agent/src/pipeline/night-cycle/index.ts)
- [packages/providers/src/types.ts](../../../packages/providers/src/types.ts) — `ChatRequest` получает `signal?`
- [packages/providers/src/nvidia.ts](../../../packages/providers/src/nvidia.ts), [packages/providers/src/nvidia.ts](../../../packages/providers/src/nvidia.ts) — проверка `signal.aborted`
- [packages/core/src/lib/model-router.ts](../../../packages/core/src/lib/model-router.ts) — проброс signal
- `tests/arbitration.test.ts` (новый/расширить)
- `tests/tool-runner.test.ts` (новый/расширить)
- `tests/night-cycle.test.ts` (новый/расширить)

## Порядок исполнения

1. HIGH-5 (санитизация тегов) — самый маленький, изолированный.
2. HIGH-6 (транзакция) — локально в night-cycle, не трогает pipeline.
3. HIGH-3 (tool timeout) — `ToolError{code:"timeout"}` уже должен быть в типах (Часть IV мастер-плана). Добавить scope-map в начало `tool-runner.ts`.
4. HIGH-2 (arbitration abort) — самый инвазивный: signal пробрасывается через `ModelRouter` и провайдеры. Делать последним, чтобы не смешивать с остальным в diff.

## Приёмка

- [ ] `bunx tsc --noEmit` = 0.
- [ ] `bun test` — ≥80 pass, все новые тесты зелёные.
- [ ] Ручной smoke: арбитражный чат с N=3, принудительно ломаем один специалист (переменной среды или мок) → ответ всё равно приходит.
- [ ] В [docs/02-audit.md](../../02-audit.md) вычеркнуть HIGH-2, HIGH-3, HIGH-5, HIGH-6 со ссылкой на PR.
