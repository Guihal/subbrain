# Задача 15 — Тесты + документация (финальный PR)

**Оценка:** 1 день
**Зависимости:** после всех PR 01-14
**Status:** TODO

## Цель

Закрыть «Часть VI. Тесты» и «Часть VII. Документация» из мастер-плана. Зафиксировать новую структуру в доках и поднять покрытие.

## Часть A — тесты

Список новых тестов (из «Часть VI» мастер-плана), отфильтрованный от того, что уже покрыто PR 01-14:

### `tests/mcp-registry.test.ts` (smoke MCP registry)
- `listTools(scope: "public")` возвращает ожидаемое кол-во (зафиксировать в snapshot/константе).
- `listTools(scope: "agent-only")` — то же.
- Все handler'ы вызываются без crash на mock-`AgentContext` (`{ executor: mockExecutor, router: undefined, ... }`) — agent-only handler'ы корректно обрабатывают отсутствие optional полей (либо throw `ToolError{code:"context_missing"}`, либо корректно отвечают на простых аргументах).

### `tests/agent-loop-step.test.ts`
- Уже создан в PR 08. В этом PR — добавить пограничные кейсы: пустой response от модели, `finish_reason: "length"` без tool_calls, `done`-tool с пустым `data`.

### `tests/night-cycle-steps.test.ts`
- Каждый step (translate, pii-scrub, dedup, compress, verify) на одном мок-record'е. Сейчас только end-to-end → нет sanity-check'а отдельных шагов.
- Mock `ModelRouter`, проверка что step → правильный prompt + правильный output flow в next step.

### `tests/memory-routes.test.ts` (memory admin)
- 5 слоёв (`focus`, `shared`, `context`, `archive`, `agent`) × 4 операции (list, get, patch, delete) = 20 тестов.
- Поверх Elysia test client с тестовой БД.
- Цель: ловит регрессии в PR 10 (split db) и PR 11 (UI ожидает определённый envelope формат).

### `tests/context-compressor.test.ts`
- Сериализация summary + facts.
- Сценарий: messages с `> SOFT_LIMIT` chars → `compressMessages` возвращает true, `messages.length` сократилась, summary вставлен как assistant, `shared_memory.insertShared` вызван по числу facts.
- Edge case: компрессор упал → `false`, исходный массив не мутирован.

### `tests/http-client.test.ts`
- Уже создан в PR 03. В этом PR — sanity-проверка что не сломан.

### `tests/browser-smoke.ts` (leak)
- Уже создан в PR 06 шаг C. В этом PR — добавить в README инструкцию запуска.

## Часть B — документация

### Обязательные обновления

| Файл | Что обновить |
|---|---|
| [docs/completed/01-server-skeleton.md](../../completed/01-server-skeleton.md) | Структура `src/app/*` после PR 07 |
| [docs/completed/06-agent-pipeline.md](../../completed/06-agent-pipeline.md) | Phases pre/main/post + post/{hippocampus,extractors,gate} после PR 09 |
| [docs/completed/02-database-schema.md](../../completed/02-database-schema.md) | `db/tables/*` после PR 10 |
| [docs/02-audit.md](../../02-audit.md) | По каждому закрытому пункту HIGH/MED — ✅ + ссылка на PR |
| [docs/01-refactor-plan.md](../../01-refactor-plan.md) | Таблица PR — все строки вычеркнуты, добавить «всё закрыто YYYY-MM-DD» |
| [CLAUDE.md](../../../CLAUDE.md) | Все file-path'ы после splitting'а; новая секция о `lib/http-client.ts`, `lib/api-envelope.ts`, `logger.child` |

### Новый файл `docs/repo-map.md`

Короткая карта директорий после splitting'а — один экран, для затравки LLM-сессии:

```markdown
# Repo map

## Server
- src/index.ts             — entrypoint (~50 строк)
- src/app/                 — bootstrap, schedulers, autonomous-run, shutdown
- src/routes/              — Elysia routes (chat, memory, embeddings, logs, ...)

## Pipelines
- src/pipeline/agent-pipeline/  — pre/main/post phases + direct-mode
- src/pipeline/agent-loop/      — autonomous loop, step, tool-dispatch, heartbeat
- src/pipeline/night-cycle/     — daily memory consolidation
- src/pipeline/arbitration-room.ts — multi-specialist debate
- src/pipeline/context-compressor.ts — soft-limit collapse

## Providers
- src/providers/copilot.ts, nvidia.ts, openrouter.ts
- src/providers/sse-parser.ts (shared SSE chunk parsing)
- src/providers/types.ts

## DB / Memory
- src/db/index.ts (orchestrator), schema.ts, types.ts
- src/db/tables/{memory,chats,logs,kv,users}.ts
- src/rag/pipeline.ts (FTS + sqlite-vec + rerank)

## MCP
- src/mcp/registry/*.tools.ts (single source of truth)
- src/mcp/tools/* (domain logic)
- src/mcp/playwright-client.ts (direct chromium)

## Lib
- http-client, errors, logger, api-envelope, fts-utils, model-map, model-router, rate-limiter, sse, auth

## Web
- web/app/pages/{chat,memory}.vue (shells)
- web/app/composables/useChat{State,Stream,Persistence,Mode}.ts
- web/app/composables/useMemoryLayer.ts (factory)
- web/app/components/memory/{LayerView,EditModal,FilterBar,LogView}.vue
```

### Observability map (из «Часть V»)

В [docs/completed/08-observability.md](../../completed/08-observability.md) добавить таблицу «что покрыто метриками / нет»:

| Путь | metrics.ts? | request_id? |
|---|---|---|
| RAG hybrid search | ? | ? |
| Rate limiter acquire | ? | ? |
| Night-cycle each step | ? | ? |
| Agent-loop step | ? | ? |
| Tool timeout | ? | ? |

Заполнить грепом по `metrics.` — что отсутствует, добавить точки замера в этом PR.

### `request_id` middleware

В `src/app/bootstrap.ts` — middleware:
```ts
.derive(() => ({ requestId: crypto.randomUUID() }))
.onBeforeHandle(({ requestId, request }) => {
  request.headers.set("x-request-id", requestId);
})
```

И прокидывать в `logger.child({request_id})` в роутах + в `ModelRouter.chat({requestId})`.

## Файлы

- Все тесты выше.
- Все доки выше.
- `src/lib/metrics.ts` — добавить недостающие call-points.
- `src/app/bootstrap.ts` — request_id middleware.

## Порядок исполнения

1. Сначала тесты (5 файлов) — фиксируют состояние перед документированием.
2. Грепы по `metrics.` + добавление недостающих точек.
3. `request_id` middleware.
4. Обновление `docs/completed/*` файлов.
5. Создание `docs/repo-map.md`.
6. Финальная вычеркивание строк в `docs/02-audit.md` и `docs/01-refactor-plan.md`.
7. Обновление [CLAUDE.md](../../../CLAUDE.md) — последним, после того как все пути зафиксированы.

## Приёмка

- [ ] `bunx tsc --noEmit` = 0.
- [ ] `bun test` ≥ 90 pass / 0 fail (старт был 78; +5 файлов × ~3 теста + 20 memory-routes ≈ 33 новых).
- [ ] `bun run tests/integration.live.ts` end-to-end проходит.
- [ ] Manual smoke на prod (по чеклисту мастер-плана секция «Приёмка»):
  - [ ] Создать chat в UI → ответ через pipeline.
  - [ ] Memory admin: открыть все 6 вкладок, edit/delete работают.
  - [ ] Автономный агент 3 шага без ошибок.
  - [ ] `curl -X POST http://127.0.0.1:4000/night-cycle` → отрабатывает.
  - [ ] `web_navigate + web_snapshot` × 3 → ok, `ps ax | grep chrome | wc -l` без leak.
- [ ] [docs/02-audit.md](../../02-audit.md) — все HIGH ✅, BROWSER-1 закрыт.
- [ ] [docs/01-refactor-plan.md](../../01-refactor-plan.md) — таблица PR полностью закрыта.
