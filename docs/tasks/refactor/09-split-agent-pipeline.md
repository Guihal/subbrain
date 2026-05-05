# Задача 09 — Splitting `agent-pipeline/*`

**Оценка:** 1 день
**Зависимости:** —
**Status:** DONE

## Цель

Разнести три толстых файла:
- [packages/agent/src/pipeline/agent-pipeline/index.ts](../../../packages/agent/src/pipeline/agent-pipeline/index.ts) (~422 строки) — оркестратор.
- [packages/agent/src/pipeline/agent-pipeline/post-processing.ts](../../../packages/agent/src/pipeline/agent-pipeline/post-processing.ts) (~402 строки) — две ответственности (агентский цикл + extractors).
- [packages/agent/src/pipeline/agent-pipeline/pre-processing.ts](../../../packages/agent/src/pipeline/agent-pipeline/pre-processing.ts) (~334 строки).

## Целевая структура

```
packages/agent/src/pipeline/agent-pipeline/
├── index.ts                    # ≤100: AgentPipeline.execute() оркестратор
├── phases/
│   ├── pre.ts                  # фаса pre-processing (агрегатор pre/*)
│   ├── main.ts                 # вызов специалиста (теcущий main pipeline path)
│   ├── post.ts                 # фаса post-processing (агрегатор post/*)
│   └── direct-mode.ts          # load-shedding (сейчас inline в index.ts)
├── pre/
│   ├── exec-summary.ts         # сборка executive summary
│   ├── rag-inject.ts           # RAG hits → system message
│   └── focus-inject.ts         # Layer 1 focus → system
└── post/
    ├── hippocampus.ts          # маленький agent-loop (modelRouter + 3 тула)
    ├── extractors.ts           # memory_write по слоям (shared / context)
    └── gate.ts                 # должен ли запускаться (длина, cooldown, char-limit 100)
```

## Что куда

### `index.ts` (≤100 строк)
```ts
export class AgentPipeline {
  async execute(req: PipelineRequest): Promise<PipelineResponse> {
    if (this.shouldUseDirectMode(req)) return runDirectMode(req, this.deps);
    const ctx = await runPre(req, this.deps);
    const result = await runMain(ctx, this.deps);
    runPost(req, result, this.deps).catch(err => logger.warn("agent-pipeline", "post_failed", {err}));
    return result;
  }

  private shouldUseDirectMode(req: PipelineRequest): boolean {
    return req.headers["x-direct-mode"] === "true" || this.deps.router.isOverloaded;
  }
}
```

### `phases/pre.ts`
- `runPre(req, deps): Promise<PreContext>` — собирает результат из:
  - `injectFocus(systemMessages)`
  - `runRagInject(systemMessages, req.messages)`
  - `buildExecutiveSummary(...)`
- Возвращает `PreContext = { messages, summary, ragHits }`.

### `phases/main.ts`
- `runMain(ctx, deps): Promise<MainResult>` — формирует request к ModelRouter, обрабатывает direct vs streaming.

### `phases/post.ts`
- `runPost(req, result, deps): Promise<void>` — fire-and-forget.
  - `if (!shouldRunHippocampus(req, result)) return;`
  - `await runHippocampus(req, result, deps);`
  - Внутри hippocampus уже использует `extractors`.

### `phases/direct-mode.ts`
- `runDirectMode(req, deps)` — короткий путь без pre/post, прямой `ModelRouter.chat()` + SSE-проксирование.

### `pre/exec-summary.ts`
- Текущая логика flash-агентского сбора summary; интерфейс `buildExecutiveSummary(req, deps): Promise<string>`.

### `pre/rag-inject.ts`
- `runRagInject(systemMessages, userMessages, deps): Message[]` — gate (только новый чат), вызов `rag.hybridSearch`, склейка hits в system message.

### `pre/focus-inject.ts`
- `injectFocus(systemMessages, deps): Message[]` — добавляет `layer1_focus` + `shared_memory` в каждый system prompt.

### `post/hippocampus.ts`
- Маленький agent-loop: `MAX_HIPPO_STEPS = 5`, тулы `[memory_search, memory_write, done]`, модель `POST_EXTRACTOR_MODEL` (default `coder`).
- ⚠️ комментарий: «не использовать `flash` — reasoning model, не вызывает tool_calls». Сохранить, это критично.

### `post/extractors.ts`
- `memoryWriteShared(args, deps)` → `memory.insertShared()`.
- `memoryWriteContext(args, deps)` → `memory.insertContext()` + `rag.indexEntry()`.
- Вынесено отдельно, чтобы тестировать и переиспользовать.

### `post/gate.ts`
- `shouldRunHippocampus(req, result): boolean`:
  - `userMessage.length + assistantText.length >= 100` → true.
  - cooldown — если был запуск hippocampus < 30s назад в этой же сессии → false (опционально).

## Тесты

- `tests/pipeline-pre.test.ts` (новый) — `runPre` с mock-deps возвращает `PreContext` с правильно склеенным system + RAG hits.
- `tests/pipeline-post-gate.test.ts` (новый) — `shouldRunHippocampus` для разных длин.
- `tests/pipeline-post-hippocampus.test.ts` (новый) — mock-router возвращает один `memory_write` → extractors вызваны с правильными аргументами.
- Существующие `tests/agent-pipeline.test.ts` — продолжают зеленеть.

## Файлы

- [packages/agent/src/pipeline/agent-pipeline/index.ts](../../../packages/agent/src/pipeline/agent-pipeline/index.ts) (сократить)
- [packages/agent/src/pipeline/agent-pipeline/post-processing.ts](../../../packages/agent/src/pipeline/agent-pipeline/post-processing.ts) (удалить, content разнесён)
- [packages/agent/src/pipeline/agent-pipeline/pre-processing.ts](../../../packages/agent/src/pipeline/agent-pipeline/pre-processing.ts) (удалить, content разнесён)
- Новые файлы: `phases/pre.ts`, `phases/main.ts`, `phases/post.ts`, `phases/direct-mode.ts`, `pre/exec-summary.ts`, `pre/rag-inject.ts`, `pre/focus-inject.ts`, `post/hippocampus.ts`, `post/extractors.ts`, `post/gate.ts`
- Тесты выше.
- [docs/completed/06-agent-pipeline.md](../../completed/06-agent-pipeline.md) — обновить под новую структуру.
- [CLAUDE.md](../../../CLAUDE.md) — поправить пути в секции «Agentic post-processing (hippocampus)» и «Request flow has two modes».

## Порядок исполнения

1. `pre/focus-inject.ts` (минимальный, изолированный).
2. `pre/rag-inject.ts`.
3. `pre/exec-summary.ts`.
4. `phases/pre.ts` (агрегирует 1-3) → удаление `pre-processing.ts`.
5. `post/gate.ts`.
6. `post/extractors.ts`.
7. `post/hippocampus.ts`.
8. `phases/post.ts` → удаление `post-processing.ts`.
9. `phases/direct-mode.ts` (вытащить inline блок из `index.ts`).
10. `phases/main.ts`.
11. Сократить `index.ts` до ≤100 строк.

## Приёмка

- [ ] `bunx tsc --noEmit` = 0.
- [ ] `bun test` зелёные.
- [ ] `wc -l packages/agent/src/pipeline/agent-pipeline/index.ts` ≤ 100.
- [ ] Все файлы в `agent-pipeline/` ≤ 250 строк.
- [ ] `bun run tests/integration.live.ts` end-to-end проходит (особенно: чат через pipeline создаёт записи в `shared_memory` через hippocampus).
