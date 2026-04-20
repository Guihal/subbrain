# План рефакторинга subbrain (2026-04-20)

> Прежнее имя: `docs/15-refactor-plan-2026-04-20.md`
>
> **Активные таски:** [docs/tasks/refactor/](tasks/refactor/) — 15 файлов, по одному на PR.

Цель: закрыть открытые баги из [docs/02-audit.md](02-audit.md), разбить разросшиеся файлы, выровнять повторы — не меняя внешнего поведения. Каждый пункт — отдельный PR (дешёвое ревью и откат). Порядок: сначала bugfix, затем splitting, иначе рефакторинг поглотит фиксы и в diff их не видно.

---

## Часть I. Фиксы открытых багов

### Блок A. Надёжность pipeline (HIGH-2/3/5/6)

- **HIGH-2** — `arbitration-room.ts`: `Promise.all` → `allSettled`; `AbortController.abort()` остальных после первой удачи через `signal`, прокинутый в `ModelRouter.chat()` и провайдеры. Провайдеры проверяют `signal.aborted` перед стартом запроса и в callback стрима. Тест: моковый провайдер кидает на 2-м шаге → арбитраж возвращает результат от оставшихся.
- **HIGH-3** — per-tool timeout в `agent-loop/tool-runner.ts`: `Promise.race([exec, timeout(N)])`; N по scope: `web_*`=15s, `memory_*`=3s, `embed_*`=5s, `consult_*`=20s, остальное 5s. Таймаут не кидается, а попадает в `tool_result` как `ToolError{code:"timeout", name}` — модель сама решает, повторять или идти дальше.
- **HIGH-5** — `night-cycle/steps.ts:187`: tags прогнать через `sanitizeFtsQuery` из `lib/fts-utils.ts`. Unit-test со «злым» тегом (`tag"with:quote*`).
- **HIGH-6** — `night-cycle/index.ts:86-101`: `insertArchive` + `rag.indexEntry` в `db.transaction()`. Фейл эмбеддинга — откат, `warn`, retry следующей ночью. Без транзакции архив с `NULL`-вектором навсегда невидим для RAG.

### Блок B. Hardening (HIGH-1/4/7/8/9/10)

- **HIGH-1** — `rate-limiter.ts`: атомарный `tryAcquire()` под `Map<provider, Mutex>`; возвращает `{ok:true, token}` или `{ok:false, waitMs}`. `ModelRouter` при `ok=false` либо ждёт `waitMs`, либо fallback'ит.
- **HIGH-4** — `model-router.ts`: `MAX_FALLBACK_ATTEMPTS=1`; после второго 4xx → `UpstreamExhaustedError` → HTTP 502 `upstream_exhausted`. Direct-mode ловит и возвращает клиенту без переключения цепочки.
- **HIGH-7** — `rag/pipeline.ts`: `vecSearch` → batch `WHERE id IN (?,?,…)` одним запросом; `getRecencyBoost` читает `updated_at` из `RAGResult` (кэш в первом SELECT). Экономия — до 60 SELECT'ов на RAG-запрос.
- **HIGH-8** — `lib/http-client.ts`: `fetchJson<T>(url, init, {timeoutMs, signal})`; унифицирует 7 мест `fetch` в `providers/copilot.ts`, `providers/nvidia.ts`, `rag/pipeline.ts`, `telegram/bot.ts`, `telegram/userbot.ts`. Default 60s, override для Copilot streams (180s). Внутри — `AbortSignal.timeout()` + compose с внешним signal (HIGH-2).
  - По замечанию критика: оценка **1 день**, обязателен `tests/http-client.test.ts` с мок-сервером — compose'нные сигналы при параллельных запросах могут менять порядок отмен.
- **HIGH-9** — `routes/chat.ts:wrapStreamForChat`: флаг `isClosed` при `signal.aborted || ws.closed`; запретить `db.updateChatMessage` после срабатывания. Тест: long-stream, клиент дисконнектится на 3-м chunk'е, БД не содержит частичный ответ.
- **HIGH-10** — `lib/auth.ts:40`: хэш обе стороны через `crypto.subtle.digest('SHA-256')`, `timingSafeEqual` на 64-hex фиксированной длины.

### Блок C. MEDIUM пачкой (один PR «hardening quality»)

- **MED-1** generic `updateRow(table, allowlist, id, patch)` в `db/index.ts` (whitelist колонок — `Set<string>` рядом с таблицей).
- **MED-2** `RERANK_MODEL` константа в `lib/model-map.ts` рядом с `EMBED_MODEL`.
- **MED-3** `scripts/seed.ts` требует `--confirm` или path≠prod; без флага — `exit 1`.
- **MED-4** `logger.ts:107` — `JSON.stringify` всех meta-значений перед записью в SQLite.
- **MED-5** `agent-loop/code-tools/sandbox.ts:43` — явная проверка `typeof Worker !== "undefined"`, иначе `throw new Error("sandbox_unavailable")`. Без fallback на `new Function()`.
- **MED-6** `Message.reasoning_content?: string` в `providers/types.ts`, убрать `(m as any).reasoning_content` по всему pipeline.
- **MED-7** `pre-processing.ts:151-154` — убрать лишний `Promise.all` вокруг sync-кода.
- **MED-8** `rag/pipeline.ts:69` — перед `rrfMerge` дедуп через `Map<id, Result>`.
- **MED-9** `night-cycle/steps.ts:updateArchive` — пересчёт embedding после merge + `indexEntry(id, newVector)`.
- **MED-10** миграция v3 в `db.transaction()` (сейчас DROP+RENAME не атомарны).
- **MED-11** `routes/logs.ts` — маск `api_key`/`authorization`/`token` по умолчанию, `?raw=1` снимает.
- **MED-12** `model-router.ts:269` — `msg.slice(0, 500)` в SSE error.
- **MED-13** `stream-utils.ts:37` — `logger.error("stream-utils", ...)` вместо `console.error`.
- **MED-14** `routes/chat.ts:131` — `err.body.slice(0, 200)` + regex-redact `/api[_-]?key/i`.

### Блок D. BROWSER-1

Агент не умеет сёрфить — `web_*` зависает на CDP-хендшейке `@playwright/mcp`.

1. **Шаг A** — обновить `@playwright/mcp` до свежей стабильной. Smoke: 3 прогонки `web_navigate` + `web_snapshot` в Docker'е > 10 мин.
2. **Шаг B** — если A не помог: `src/mcp/playwright-client.ts` переписать на прямой `chromium.launch({channel:'chrome'})` + 6 методов (navigate/snapshot/click/type/back/press_key). Интерфейс `callTool(name, args)` не меняется, `registry/web.tools.ts` не трогается. Убирается отдельный процесс + MCP-протокол.
3. **Leak-smoke (по замечанию критика):** `ps ax | grep chrome | wc -l` до/после agent-run = 0 разницы; логировать число открытых контекстов в `shutdown.ts`. Без этого CDP-сессии утекают и браузеры копятся в памяти контейнера.

---

## Часть II. Code splitting

Критерий: одна ответственность, ≤250 строк, имя отвечает на «что тут происходит». Не режем ради размера — `system-prompt.ts` (247) = один логический промпт, резать нечего.

### Server bootstrap

[src/index.ts](../src/index.ts) (440 стр.) → `src/app/`:

- `app/bootstrap.ts` — создание Elysia, mount роутов, middleware, `listen`.
- `app/schedulers.ts` — night-cycle scheduler, autonomous-scheduler, идемпотентные guards.
- `app/autonomous-run.ts` — SSE heartbeat loop (сейчас inline 60 строк в `index.ts`).
- `app/shutdown.ts` — graceful shutdown (DB close, playwright cleanup).
- `src/index.ts` → ~50 строк: import bootstrap + start.

### Agent-loop

[src/pipeline/agent-loop/index.ts](../src/pipeline/agent-loop/index.ts) (625 стр.) → внутри той же папки:

- `index.ts` — фасад `AgentLoop` класс, ≤80 строк, только оркестрация.
- `run.ts` — `run()` (non-stream) + `createStream()` (stream); логика step'а общая.
- `step.ts` — один step: request к ModelRouter → parse tool_calls → dispatch → собрать messages.
- `tool-dispatch.ts` — нормализация `tool_calls` (OpenAI vs Anthropic flavor), вызов `tool-runner`, сборка `tool_result`.
- `heartbeat.ts` — SSE-heartbeat + `idleTimeout` guards.
- `compressor-hook.ts` — вызов `context-compressor` перед каждым step'ом.
- `system-prompt.ts` остаётся как есть.

### Agent pipeline

[src/pipeline/agent-pipeline/index.ts](../src/pipeline/agent-pipeline/index.ts) (422) → разбить оркестратор:

- `index.ts` — `AgentPipeline.execute()` ≤100 строк.
- `phases/pre.ts`, `phases/main.ts`, `phases/post.ts`.
- `phases/direct-mode.ts` — load-shedding логика (сейчас inline).

[post-processing.ts](../src/pipeline/agent-pipeline/post-processing.ts) (402) — две ответственности:

- `post/hippocampus.ts` — маленький agent-loop (modelRouter + 3 тула).
- `post/extractors.ts` — логика `memory_write` разных слоёв.
- `post/gate.ts` — проверка «стоит ли запускать» (длина, cooldown).

[pre-processing.ts](../src/pipeline/agent-pipeline/pre-processing.ts) (334) →

- `pre/exec-summary.ts` — сборка executive summary.
- `pre/rag-inject.ts` — подмешивание RAG hits в system.
- `pre/focus-inject.ts` — Layer 1 injection.

### Database

[src/db/index.ts](../src/db/index.ts) (~716 стр.) → `db/tables/`:

- `tables/memory.ts` — Layer 1..3 CRUD (focus/shared/context/archive/agent).
- `tables/chats.ts` — chat rooms + messages.
- `tables/logs.ts` — raw_log (Layer 4).
- `tables/kv.ts` — key-value (`night_cycle_last_processed_id` и т.п.).
- `tables/users.ts` — если есть auth-related rows.
- `db/index.ts` — orchestrator, объединяет tables в класс `MemoryDB`.
- `db/schema.ts` остаётся единой точкой миграций.

### Web frontend (самое запущенное)

[web/app/pages/memory.vue](../web/app/pages/memory.vue) (651!) — 6 почти идентичных вкладок:

- `pages/memory.vue` — shell ≤100 строк, табы + роутинг.
- `components/memory/MemoryLayerView.vue` — generic список + paginator + search + edit-modal, принимает `layer` пропом.
- `components/memory/MemoryEditModal.vue` — единственная edit-форма, поля из `layerSchema[layer]`.
- `components/memory/MemoryFilterBar.vue`.
- `components/memory/MemoryLogView.vue` — read-only Layer-4.

[composables/useMemory.ts](../web/app/composables/useMemory.ts) (440) → generic factory:

- `composables/useMemoryLayer.ts` — `useMemoryLayer<T>(layer)`. Возвращает `{items, total, page, q, load, save, remove}`.
- Специфичные слои (log read-only, focus KV) — минимальные composables поверх factory.

[composables/useChat.ts](../web/app/composables/useChat.ts) (430) →

- `useChatState.ts` — reactive messages + текущий room.
- `useChatStream.ts` — fetch SSE + parse chunks + append.
- `useChatPersistence.ts` — save/load rooms.
- `useChatMode.ts` — режим (pipeline/direct/agent) + `max_steps`.

### MCP registry

Уже разделён (`registry/*.tools.ts`). Не трогать.

---

## Часть III. Упрощение (без потери логики)

1. **`lib/http-client.ts`** — 7 мест copy-paste `fetch` → один canonical путь (trace-id/retry/request-id централизованно). ~80 строк экономии.
2. **`providers/sse-parser.ts`** — `parseSSEChunk(line) → ProviderDelta` + `assembleMessage(deltas[]) → Message`. `copilot.ts` и `nvidia.ts` переиспользуют, caller-specific остаётся только маппинг запрос/ответ.
3. **Tool dispatcher** в `agent-loop/tool-runner.ts` — массив `resolvers: ToolResolver[]` с приоритетом (registry → dynamic → code); первый `.canResolve(name)` исполняет. Новый вид инструментов — push в массив.
4. **`lib/api-envelope.ts`** — `PaginatedResponse<T>` + `paginate(query, {page, pageSize, q})`; `routes/memory.ts` повторяет это 5 раз с локальными вариациями.
5. **`AppError` + central `onError`** в Elysia — единый JSON-формат, ловит `UpstreamExhaustedError`/`ToolError`/TypeBox-валидацию. Вместо 10 `.onError` в рутах.
6. **`logger.child("stage")`** — один `const log = logger.child("copilot")` в топе файла, далее `log.info(...)`. Без повторения stage-имени в каждом вызове.
7. **Две папки "tools"** (`mcp/tools/` и `mcp/registry/`) — короткий README в каждой: «domain logic» vs «schema+wiring». Иначе следующий рефакторинг снесёт одну по ошибке.

---

## Часть IV. Контракты и типы

- **`AgentContext`** → discriminated union `PublicContext` (только `executor`) vs `AgentContext` (все поля required). Убирает `ctx.router!` throughout.
- **`ToolResult`** единый `{ok:true, data:unknown} | {ok:false, error:{code, message}}`. Registry оборачивает автоматически.
- **`ProviderResponse`** — закрытый union (text | tool_calls | mixed), без `any`-cast в `routes/chat.ts`.

---

## Часть V. Observability и DX

- Пройтись по критичным путям (RAG, rate-limit, night-cycle шаги, agent-loop step, tool timeouts) и проверить, что `lib/metrics.ts` зовётся. Карта «что покрыто / нет» в [docs/completed/08-observability.md](completed/08-observability.md).
- `request_id` генерировать в middleware Elysia, прокидывать в `logger.child({request_id})` и `ModelRouter`.
- `docs/repo-map.md` (новый) — короткая карта директорий после splitting'а, полезно для input LLM-сессий.

---

## Часть VI. Тесты

Сейчас 78 pass / 0 fail (после Round 1 аудита). Добавить:

- **smoke MCP registry** — `listTools(scope)` возвращает ожидаемое кол-во, все handler'ы вызываются без crash на mock-context.
- **agent-loop step isolation** — mock-ModelRouter + mock-ToolRunner; один step делает ровно один tool call.
- **night-cycle steps** — каждый step на одном мок-record'е (сейчас только end-to-end).
- **memory admin routes** — 5 слоёв × 4 операции = 20 тестов. Ловит регрессии splitting'а.
- **context-compressor** — сериализация summary + facts.
- **http-client** — мок-сервер + compose'нные сигналы + таймаут-поведение.
- **browser leak smoke** (BROWSER-1 шаг B) — `ps ax | grep chrome | wc -l` до/после agent-run.

---

## Часть VII. Документация

- [docs/completed/01-server-skeleton.md](completed/01-server-skeleton.md) — обновить после splitting'а `src/index.ts`.
- [docs/completed/06-agent-pipeline.md](completed/06-agent-pipeline.md) — под новую структуру `agent-pipeline/phases/*`.
- [docs/02-audit.md](02-audit.md) — по каждому закрытому пункту ✅ + ссылка на PR.
- [CLAUDE.md](../CLAUDE.md) — проверить все file-path'ы после splitting'а, обновить.

---

## Порядок исполнения

Bugfix сначала, splitting после — чтобы diff-ы не смешивались. Каждый PR — отдельный.

| PR | Содержание | Оценка | Блокер | Task |
|---|---|---|---|---|
| 1 | HIGH-2, 3, 5, 6 (pipeline robustness) | 1 день | — | [01](tasks/refactor/01-pipeline-robustness.md) |
| 2 | HIGH-1, 4, 7, 9 (race / cap / N+1 / SSE) | 1 день | после PR 1 | [02](tasks/refactor/02-hardening-race-cap-n1-sse.md) |
| 3 | HIGH-8 (http-client унификация) | **1 день** | — | [03](tasks/refactor/03-http-client-unification.md) |
| 4 | ✅ HIGH-10 (auth timing) | 0.5 часа | — | [04](tasks/refactor/04-auth-timing.md) |
| 5 | MEDIUM pack (MED-1…14) | 1 день | — | [05](tasks/refactor/05-medium-pack.md) |
| 6 | BROWSER-1 попытка A → B + leak-smoke | 1–1.5 дня | — | [06](tasks/refactor/06-browser-playwright-direct.md) |
| 7 | Splitting `src/index.ts` → `app/*` | 0.5 дня | — | [07](tasks/refactor/07-split-index-to-app.md) |
| 8 | Splitting `agent-loop/index.ts` | 1 день | после 1, 2 | [08](tasks/refactor/08-split-agent-loop.md) |
| 9 | Splitting `agent-pipeline/*` | 1 день | — | [09](tasks/refactor/09-split-agent-pipeline.md) |
| ~~10~~ | ~~Splitting `db/index.ts` → `db/tables/*`~~ | ~~0.5 дня~~ | ~~—~~ | ✅ [10](tasks/refactor/10-split-db-tables.md) |
| 11 | Splitting `memory.vue` + `useMemory` | 1 день | — | [11](tasks/refactor/11-split-memory-page.md) |
| 12 | Splitting `useChat.ts` | 0.5 дня | — | [12](tasks/refactor/12-split-use-chat.md) |
| 13 | AppError + logger.child + PaginatedResponse | 0.5 дня | после 10 | [13](tasks/refactor/13-app-error-logger-envelope.md) |
| 14 | ✅ SSE parser унификация в providers | 0.5 дня | — | [14](tasks/refactor/14-sse-parser-providers.md) |
| 15 | Тесты smoke + docs update | 1 день | после всех | [15](tasks/refactor/15-tests-docs-acceptance.md) |

Суммарно ~10–11 дней в одну руку; большинство PR независимы (кроме зависимостей в таблице) — можно распараллелить.

---

## Что намеренно не трогаем

- [src/pipeline/agent-loop/system-prompt.ts](../src/pipeline/agent-loop/system-prompt.ts) (247) — один логический промпт, резать ради метрики нет смысла.
- [src/lib/model-map.ts](../src/lib/model-map.ts) — маленький и правильный.
- [src/rag/pipeline.ts](../src/rag/pipeline.ts) (357) — остаётся цельным, правки только точечные (MED-2, MED-8, HIGH-7).
- MCP registry — уже разделён.
- Телеграм-модули (302+356) — специфичная логика (MTProto vs Bot API), splitting без практической пользы.

---

## Приёмка

- `bunx tsc --noEmit` — exit 0.
- `bun test` — ≥80 pass / 0 fail (сейчас 78).
- `bun run tests/integration.live.ts` — полный end-to-end на dev-сервере.
- Manual smoke на prod: создать chat в UI → ответ через pipeline → memory admin → автономный агент 3 шага → night-cycle trigger.
- [docs/02-audit.md](02-audit.md) — все HIGH ✅, BROWSER-1 закрыт, браузеры не утекают.
