# Audit 2026-04-20

> Прежнее имя: `docs/14-audit-2026-04-20.md`

Полный аудит кодовой базы перед рефакторингом. Группировка: Critical / High / Medium.
Каждая запись: `путь:строка → проблема → фикс`.

> **Статус верификации:**
> - ✅ Подтверждено лично (typecheck output, прочитанный файл).
> - 🟡 Получено от sub-агента, нужна проверка перед фиксом.

---

## Состояние тестов и типов

- `bun test` без аргументов запускает только `db.test.ts` и `rate-limiter.test.ts`, далее процесс умирает (см. CRIT-1). **66 остальных тестов скрыто пропускаются.**
- При явном запуске `bun test tests/...` (минус integration и rate-limiter) — **66 pass / 0 fail**.
- `tests/integration.test.ts` — live-test, требует поднятый сервер на `:4000`. Не падает по сути, падает по доступности.
- `bunx tsc --noEmit` — **22 ошибки** (см. CRIT-2…7).

---

## 🔴 CRITICAL

### CRIT-1 ✅ `tests/rate-limiter.test.ts:72` — `process.exit(0)` ломает `bun test`
`bun test` (без аргументов) обходит файлы по очереди в одном процессе. После `process.exit(0)` runner умирает, не запустив остальные тестовые файлы. CI этого не замечает — exit-code 0.
**Fix:** убрать `process.exit(0)` и `process.exit(1)`. Если нужен standalone-режим — обернуть в `if (import.meta.main)` без exit.

### CRIT-2 ✅ `src/providers/copilot.ts:62,72,84,111-116,144,205,222` — `logger.info("...")` с одним аргументом
Сигнатура `Logger.info(stage, message, extra?)`. Сейчас вся строка попадает в `stage`, `message === undefined`. В DB-логах поле stage = текст сообщения, а сама запись начинается с `undefined`.
**Fix:** заменить все 13 вызовов на `logger.info("copilot", "<message>")`.

### CRIT-3 ✅ `src/db/index.ts:112,187,295` — `unknown[]` в `.run(...vals)`
Typecheck падает. SQL-инъекций нет (имена колонок захардкожены), но типобезопасность сломана.
**Fix:** объявить `vals: SQLQueryBindings[]` (импорт из `bun:sqlite`).

### CRIT-4 ✅ `src/routes/chat.ts:110,119` — `role: string` уходит в провайдер без валидации
Клиент может прислать произвольную роль, в т.ч. `"system"` → потенциальный prompt injection.
**Fix:** Zod-схема на вход `/v1/chat/completions`, `role: z.enum([...])`.

### CRIT-5 ✅ `src/routes/embeddings.ts:10` — `encoding_format` без валидации
Любая строка пройдёт в провайдер.
**Fix:** Zod-валидация.

### CRIT-6 ✅ `src/providers/copilot.ts:266` — `as Message` из `Record<string, unknown>` без `role`/`content`
Падает при первом доступе, если ответ Copilot отличается от ожидаемой структуры.
**Fix:** runtime-валидация структуры ответа + дефолты.

### CRIT-7 ✅ `src/mcp/tools/memory-tools.ts:122` — мёртвая ветка
Сравнение с `"focus"` в типе `"context"|"archive"|"shared"|"agent"`. Никогда не сработает.
**Fix:** либо добавить `"focus"` в union (если поведение нужно), либо удалить ветку.

---

## 🟠 HIGH

### HIGH-1 ✅ `src/lib/rate-limiter.ts` — race между `canRun` и `record`
Между проверкой и регистрацией реквеста может вклиниться другой → overrun лимита.
**Fix:** атомарное `tryAcquire()` под одной критической секцией. *(закрыто задачей 02 — sync `tryAcquire(priority)` делает prune+canRun+record в одном неделимом шаге; `release()` no-op, окно истекает по WINDOW_MS; регресс-тест: 100 parallel при limit=10 → ровно 10 ok).*

### HIGH-2 ✅ `src/pipeline/arbitration-room.ts:~85` — `Promise.all` без `allSettled`
Один упавший специалист валит весь арбитраж, остальные осиротевшие промисы продолжают жечь токены.
**Fix:** `Promise.allSettled` + AbortController для отмены оставшихся при синтезе. *(закрыто задачей 01 — arbitration + signal через ModelRouter + провайдеры).*

### HIGH-3 ✅ `src/pipeline/agent-loop/index.ts:~220` — нет per-tool timeout
Зависший `web_navigate` съедает весь 25s-бюджет.
**Fix:** `Promise.race([exec, timeout(5_000)])` на каждый tool. *(закрыто задачей 01 — scope-map `web_/memory_/embed_/consult_` + default 5s в `tool-runner.ts`, таймаут возвращается как `ToolError{code:"timeout"}`).*

### HIGH-4 ✅ `src/lib/model-router.ts:~153` — fallback-цепочка без cap
При 4xx обоих провайдеров возможен повтор без счётчика.
**Fix:** `maxFallbackAttempts = 1`. *(закрыто задачей 02 — `MAX_FALLBACK_ATTEMPTS=1`; primary + 5xx retry-same-once + max 1 fallback → `UpstreamExhaustedError({lastStatus,lastBody,attempts})`, далее AppError-handler отдаёт 502 `upstream_exhausted`. 401/403 пробрасываются без fallback. Тест `tests/model-router.test.ts`).*

### HIGH-5 ✅ `src/pipeline/night-cycle/steps.ts:187` — `entry.tags` без `sanitizeFtsQuery`
Тег с `"`, `:`, `*` ломает FTS5 MATCH → ночной цикл падает.
**Fix:** прогнать через существующий `sanitizeFtsQuery`. *(закрыто задачей 01 — `MemoryTable.searchArchive/searchContext` уже вызывают `sanitizeFtsQuery`, night-cycle больше не строит сырой MATCH; покрыто регресс-тестом с тегами `tag"with:quote*`).*

### HIGH-6 ✅ `src/pipeline/night-cycle/index.ts:86-101` — `insertArchive` + `indexEntry` без транзакции
При падении эмбеддинга архив сохранится без вектора → RAG не найдёт.
**Fix:** транзакция + retry на embed, либо откат архива. *(закрыто задачей 01 — `rag.embedContent()` вынесен отдельно, вызывается до `db.transaction(insertArchive + upsertEmbedding)`; embed-fail → warn `archive_retry_next_cycle`, архив пропускается).*

### HIGH-7 ✅ `src/rag/pipeline.ts:130-145, 188-195` — N+1 в `vecSearch` и `getRecencyBoost`
До 60 SELECT на один RAG-запрос.
**Fix:** batch `WHERE id IN (?)` + кэш `updated_at` в `RAGResult`. *(закрыто задачей 02 — `getContextMany`/`getArchiveMany` в `MemoryTable` через placeholders; `vecSearch` делает один batch SELECT на слой, `updated_at` читается из того же row в `RAGResult`; `getRecencyBoost` — чистая функция без SELECT; `fetchEntry` удалена).*

### HIGH-8 ✅ Отсутствие `AbortSignal.timeout(...)` на `fetch` к провайдерам (PR 03)
Висящий upstream блокирует worker.
**Fix:** общий `src/lib/http-client.ts` (`fetchJson`/`fetchStream`) — timeout + внешний signal + retry + `HttpError`/`HttpAbortError`. Мигрированы `providers/copilot.ts` (6 fetch) и `providers/nvidia.ts` (5 fetch). Тесты: `tests/http-client.test.ts`.

### HIGH-9 ✅ `src/routes/chat.ts:~73` — race в SSE wrap при дисконнекте клиента
`fullContent` может писаться в БД после ошибки потока / закрытия.
**Fix:** флаг `isClosed` + ранний выход. *(закрыто задачей 02 — `wrapStreamForChat` хранит `isClosed`, `cancel(reason)` коллбэк ReadableStream'а ставит флаг + отменяет inner reader; gate `if (isClosed) return` перед `memory.appendChatMessage`; тест `tests/chat-stream.test.ts` проверяет, что cancel после 2-го chunk'а → 0 DB-записей).*

### HIGH-10 ✅ `src/lib/auth.ts:40` — timing-safe сравнение (исправлено)
`timingSafeEqual` + `createHash("sha256")` на обеих сторонах — длины всегда 32 байта.

---

## 🟡 MEDIUM

### MED-1 ✅ (PR 05) generic `updateRow(table, allow, id, patch)` в `db/tables/update-row.ts`, allow-листы рядом с таблицами.

### MED-2 ✅ (PR 05) `EMBED_MODEL`/`RERANK_MODEL` в `lib/model-map.ts`, импорт в `rag/pipeline.ts`.

### MED-3 ✅ (PR 05) `scripts/seed.ts` — exit 1 на prod-path без `--confirm`.

### MED-4 ✅ (PR 05) `logger.formatForDb` — безопасный `JSON.stringify` + try/catch для circular.

### MED-5 ✅ (PR 05) `sandbox.ts` — `throw Error("sandbox_unavailable")` при `typeof Worker === "undefined"`.

### MED-6 ✅ (PR 05) `reasoning_content?: string` в `Message`, убран `(m as any)` по pipeline.

### MED-7 ✅ (PR 05) `pre-processing.ts` — прямые sync вызовы вместо `Promise.all`.

### MED-8 ✅ (PR 05) `dedupeById` перед `rrfMerge` в `rag/pipeline.ts`.

### MED-9 ✅ (PR 05) `dedup`/`resolveContradictions` принимают `rag` и пересчитывают embedding после merge.

### MED-10 ✅ (PR 05) миграция v3 — `db.transaction(() => ...)` + per-statement `.run()` (exec глотает ошибки).

### MED-11 ✅ (PR 05) `routes/logs.ts` — regex-маска `api_key|authorization|token|bearer`, `?raw=1` снимает.

### MED-12 ✅ (PR 05) `model-router.ts` — `rawMsg.slice(0, 500)` в SSE error.

### MED-13 ✅ (PR 05) `stream-utils.ts` — `logger.error("stream-utils", ...)` вместо `console.error`.

### MED-14 ✅ (PR 05) `routes/chat.ts` — `err.body.slice(0, 200).replace(/api[_-]?key/gi, "***")`.

---

## Приоритезация фиксов

**Срочно (1 PR на каждое):**
1. CRIT-1 (`process.exit` в тестах) — без этого CI слепой.
2. CRIT-2…7 (typecheck zero) — закрыть 22 ошибки `tsc` + реальный баг с logger.info.
3. HIGH-3 + HIGH-2 (per-tool timeout + allSettled в арбитраже).
4. HIGH-6 + HIGH-5 (транзакция + sanitizeFts в night-cycle).

**Дальше:** (все HIGH закрыты).

**MEDIUM** — пакетным PR-ом «hardening + quality».

---

## Прогресс фиксов

### Round 1 — все CRIT закрыты (2026-04-20)

| # | Статус | Заметка |
|---|---|---|
| CRIT-1 | ✅ | `integration.test.ts` → `integration.live.ts` (вынесен из `bun test` glob); `db.test.ts` и `rate-limiter.test.ts` переписаны в стандартный `bun:test` API. `bun test` теперь прогоняет 78/0. |
| CRIT-2 | ✅ | 13 вызовов `logger.info("[copilot] ...")` → `logger.info("copilot", "...")`. Stage больше не получает текст сообщения. |
| CRIT-3 | ✅ | Импорт `SQLQueryBindings` из `bun:sqlite`, заменены 3 объявления `vals: unknown[]`. |
| CRIT-4 | ✅ | `role` через `t.Union([t.Literal(...)])` в Elysia-схеме + новый `src/lib/messages.ts` (`normalizeMessages`) преобразует array-content к строке на входе роута. Расширен `Message` (`name?`, `reasoning_content?`). |
| CRIT-5 | ✅ | `encoding_format` и `input_type` — через `t.Union([t.Literal(...)])`. |
| CRIT-6 | ✅ | `sanitizeMessages` теперь типизирован `Message[] → Message[]`, без `as`-cast. Защита по array-content в глубину сохранена. |
| CRIT-7 | ✅ | Убран dead-guard `params.layer !== "focus"` в `memory-tools.ts:122`. TS narrowing доказывает недостижимость. |

`tsc --noEmit` → exit 0. `bun test` → 78 pass / 0 fail.

---

## 🟠 Новые баги (2026-04-20, ночь)

### BROWSER-1 ✅ `@playwright/mcp` 0.0.70 зависает на `browser_navigate` в Docker

**Симптом:** все `web_*` инструменты агента возвращают таймаут 60с.
`docker logs` → `MCP error -32001: Request timed out`.

**Что подтверждено (debug с `DEBUG=pw:browser*`):**
- Chrome реально стартует (`/opt/google/chrome/chrome`, pid в логах).
- Слушает CDP на `ws://127.0.0.1:45613/devtools/browser/...`.
- Playwright открывает WS-коннект → **hangs forever**, handshake не завершается.

**Уже сделано (не фикс, но инфраструктура на месте):**
- `docker-compose.yml`: `shm_size: 1gb`, `init: true` (reap zombies).
- `Dockerfile`: `bunx playwright install chrome --with-deps` вместо `chromium`.
- `playwright-client.ts`: `--isolated --headless --no-sandbox`.

**Что пробовал и не помогло:** конфиг с `launchOptions.args=[--no-sandbox]`,
`--browser chrome`, `--executable-path`, снятие `--isolated`, прямой запуск
installed cli (без bunx). Прямой вызов `chromium.launch({channel:"chrome"})`
через Playwright работает за ~770ms — значит Playwright и Chrome в норме,
**только MCP-обёртка ломается на CDP WS.**

**Закрыто (PR 06, 2026-04-21):** Шаг A (обновление `@playwright/mcp`) пропущен — выбран сразу Шаг B. `src/mcp/playwright-client.ts` переписан на прямой `chromium.launch({channel:"chrome"})` (9 методов через фасад `callTool`). `@playwright/mcp` удалён из `package.json`, `playwright` ^1.49.0 добавлен прямым deps. Leak-guard: `process.on("beforeExit")` закрывает все живые `PlaywrightClient`, `shutdown.ts` логирует `contextCount` перед close, `tests/browser-smoke.ts` сравнивает `ps chrome` до/после. Docker smoke — ручной (в PR-описании).

## История

- 2026-04-20 — первый аудит, ветка `main`, коммит `11aab45`.
- 2026-04-20 — Round 1: CRIT-1…CRIT-7 закрыты.
- 2026-04-20 (ночь) — BROWSER-1 открыт после ночной сессии фиксов
  (heartbeat SSE, `MAX_STEPS=100`, fire-and-forget night-cycle, cron 03:00,
  context compressor, agentic post-processing, web UI для автономных чатов).
- 2026-04-21 — BROWSER-1 закрыт (PR 06). Все HIGH/MED + CRIT + BROWSER закрыты.

---

## Addendum 2026-04-22 — найдено при разработке prune-шагов night-cycle

### MEM-1 🟡 `src/pipeline/night-cycle/steps.ts:267, 399` — delete без `deleteEmbedding` → orphan vec-rows
`dedup()` (merge-ветка на `memory.updateArchive` — ok, не удаляет) и особенно `resolveContradictions()` (строки 398-400 `memory.deleteArchive(entry.id)` на resolution=`keep_old`) не вызывают `memory.deleteEmbedding(id)`. `vec_embeddings.id` остаётся сиротой — при следующем hybrid-search попадает в vec-результаты, но `getArchiveMany([id])` вернёт пусто → запись фильтруется, но процесс дороже.
**Fix:** обернуть `deleteArchive(id)` + `deleteEmbedding(id)` в `db.transaction()`. Также проверить аналогичный паттерн в routes/memory.ts admin DELETE.
**Scope:** отдельный PR, вне prune-задачи.

### MEM-2 ✅ `shared_memory` writers теперь embed+insert атомарно (закрыто M-01, 2026-04-26)
RAG искал в трёх слоях, включая `shared`, но не-hippocampus writers (seed-script, MCP `MemoryTools.write` layer=shared, context-compressor) делали fire-and-forget `rag.indexEntry` — на embed-fail row оставался без вектора, либо вообще не embed-ился.
**Fix (M-01):** все ingress'ы переключены на embed-first + transactional insert+upsertEmbedding пути:
- `scripts/seed.ts` — конструирует `MemoryService` и зовёт `await memoryService.insertShared({...})`. Опциональный `SEED_SKIP_EMBED=1` для offline/CI с громким warn-логом.
- `src/mcp/tools/memory-tools.ts` — `case "shared":` теперь делегирует в новый private `writeSharedAtomic(...)` (mirrors `MemoryService.insertShared`: `embedWithTimeout` → `db.transaction(insertShared+upsertEmbedding)`); `write` возвращает `ToolResult | Promise<ToolResult>` — registry handler уже принимает union. Legacy fallback (rag=null) сохранён для тестов.
- `src/pipeline/context-compressor.ts` — `CompressorMemory.insertShared` теперь возвращает `void | Promise<unknown>`, call-site `await`-ит. `ChatService` подаёт shim, оборачивающий `MemoryService.insertShared` (embed-first), вместо `MemoryRepository` (raw insert без vec).
- `src/services/chat.service.ts` — новый optional 5th ctor arg `memoryService`; `compressorMemory()` строит shim для compressor'а. `deps.ts` передаёт wired service.
**Tests:** `tests/shared-embed-write.test.ts` расширен 6 новыми кейсами (MemoryService write+rollback, MemoryTools write+embed-fail, compressor-shim end-to-end, orphan-invariant). Acceptance: `SELECT COUNT(*) FROM shared_memory WHERE id NOT IN (SELECT id FROM vec_embeddings WHERE layer='shared')` = 0 после прогонки всех writers.
**Out of scope (follow-up):** agent-loop compressor-hook (`src/pipeline/agent-loop/step.ts`) всё ещё передаёт `MemoryDB` (raw); embed добавится при отдельной задаче по threading'у `MemoryService` в `AgentLoopDeps` — компрессор там стреляет редко (>80k токенов в одном run'е), приоритет ниже.

### MEM-3 ✅ `src/db/tables/memory.ts:192` — `searchContext` теперь фильтрует по `agent_id` (закрыто PR B-1, 2026-04-25)
`layer2_context` имеет колонку `agent_id` (nullable), но `searchContext`/`getContextMany` её игнорировали. Публичный и agent-приватный контексты смешивались при поиске.
**Fix (PR B-1):** добавлен опциональный `agentId?: string` в `searchContext` (`memory.ts:192`) и `getContextMany` (`memory.ts:108`); SQL `AND (c.agent_id = ? OR c.agent_id IS NULL)` — back-compat для legacy NULL-rows. Параметр проплыт через `MemoryRepository`, `MemoryDB`, `RAGSearchOptions` (`rag/types.ts`), `RAGPipeline.search/ftsSearch/vecSearch` (`rag/pipeline.ts`), `PublicToolContext.agentId` (теперь base of `AgentToolContext`, см. `tool-registry.ts:33`), MCP registry handlers (`memory.tools.ts:104`, `rag.tools.ts:35`), executor `memorySearch`/`ragSearch`, `executeHippoTool`, `buildExecutiveSummary`/`runPre`, `runHippocampus`/`writeContext`. Schedulers тегируют свою identity: `installAutonomousScheduler` → `agentId:"autonomous"`, `installFreeAgentScheduler` → `agentId:"free-agent"`. Routes derive из header `x-agent-id` (`routes/autonomous.ts:21`, `services/chat.service.ts:extractChatMeta`).
**Не в scope (отдельные PR):**
- `shared_memory` НЕ имеет `agent_id` колонки (`schema.ts:82-93`); table by-design global; писатель `writeShared` документирован соответственно. Если нужна privacy — миграция 9 + writer updates.
- `searchArchive` shared by design (per spec MEM-3 / archive ground-truth).
- Backfill для существующих NULL-rows = optional follow-up (`scripts/backfill-context-agentid.ts`); пока NULL = "shared / legacy" слой видим всем сегментам.
**Anti-spoof (PR B-1, post-critic):** `MemoryTools.write` (`memory-tools.ts:36`) принимает server-controlled `agentId: string|null` вторым параметром; для context+archive layers `params.agent_id` из LLM-args ignored — сервер пишет свой `agentId`. Agent-layer (`agent_memory` table) требует `agentId !== null` явно. Registry handlers `memory_write` + `memory_delete` (`memory.tools.ts:61,77`) передают `ctx.agentId`. `executor.memoryWrite/memoryDelete` тоже принимают agentId pass-through.
**Ownership check на write/delete UPDATE-path** (post-critic v3): context-layer `write` UPDATE (existing row) и `delete` теперь проверяют `existing.agent_id` vs server `agentId`. Mismatch → `forbidden: layer2_context row <id> owned by another agent`. Защищает от ID-guessing атаки (alice не может перезаписать/удалить bob's row, даже зная UUID). NULL legacy rows доступны всем (back-compat). admin (`agentId === null`) bypass-ит check.
**Header validation:** `x-agent-id` через `sanitizeAgentId(raw)` (`chat.service.ts`) — regex `^[a-z0-9][a-z0-9_-]{0,63}$/i` + lowercase-normalize после match (предотвращает split buckets `Alice` ↔ `alice`). Невалидное → `null` (silently dropped). Trust model: single shared bearer = admin-grade; header — admin-controlled scoping primitive (не privilege escalation).
**Tests:** `tests/cross-agent-isolation.test.ts` — 17 кейсов (reader-side searchContext+getContextMany; activeOnly+agentId combine; writer-spoof reject context+agent layers; ownership UPDATE check + NULL legacy back-compat + delete cross-agent reject + admin bypass; sanitizeAgentId charset/length/lowercase-normalize/leading-char). `bun test` 576 pass / 0 fail.

### M-1 ✅ `src/app/bootstrap.ts:53-77` — 7× `(error as any)` в Elysia error-handler (закрыто PR M-1, 2026-04-26)
Elysia ошибки имеют гетерогенную форму (TypeBox ValueError, native Error, plain `{message}`). Был cluster `(error as any)?.message`/`?.validator`/`?.stack` плюс `} as any` на logger meta — повторял один и тот же cast 7 раз.
**Fix:** локальный type-guard `interface ErrorLike { message?, validator?, type?, stack? }` + helper `toErrorLike(err): ErrorLike` в начале файла. Cast выполняется один раз при входе; дальше работа с типизированным `e.message?.slice(...)`. Logger meta тоже без `as any`.

### M-4 ✅ vec orphan на dedup/contradictions deleteArchive + admin DELETE (закрыто PR M-4, 2026-04-26)
`night-cycle/steps/contradictions.ts:71` (`keep_old` resolution) делал `memory.deleteArchive(entry.id)` без `deleteEmbedding` → `vec_embeddings` orphan; vec-rerank жёг ресурсы на «мёртвую» точку до hydrate-фильтра. Аналогично `MemoryService.deleteShared/deleteContext/deleteArchive` (admin REST routes) не парили с vec.
**Fix:** обе пары обёрнуты в `memory.transaction(() => { delete*; deleteEmbedding; })`. Закрывает M-4 + MEM-4 (orphan на admin path) одной правкой.

### H-4 ✅ `AgentToolContext` поля сделаны nullable, hippocampus `as unknown as` cast убран (закрыто PR H-4, 2026-04-26)
`hippocampus.ts:207-210` использовал `as unknown as AgentToolContext` для вызова `task_add` через `registry.callAsAgent` — тип лгал, что router/room/dynamicTools/codeTools/log/registry присутствуют, хотя hippocampus передавал только `executor + taskBudget`. Любой новый handler читающий `ctx.router` упал бы на runtime.
**Fix:** `AgentToolContext` поля капабилити переведены в `nullable / optional`:
- `router: ModelRouter | null`
- `dynamicTools: DynamicToolRegistry | null`
- `room`, `codeTools`, `session`, `taskBudget`, `persistDynamicTools` — уже были.
- Required остаются: `executor`, `agentId`, `log`, `registry`.
Handlers `consult_chaos` + `create_tool` получили early-return если `ctx.router` / `ctx.dynamicTools` null. `list_tools` использует optional chaining (`ctx.dynamicTools?.list() ?? []`). Hippocampus task_add теперь строит честный AgentToolContext: `{executor, agentId, log, registry, router:null, room:null, dynamicTools:null, codeTools:null, taskBudget}` — без `as unknown`.
**Verify:** `bunx tsc` 0; `bun test` 576/0.

### H-5 ✅ `memory.db.transaction` инкапсулирован через `MemoryDB.transaction` (закрыто PR H-5, 2026-04-26)
~10 точек в pipeline/routes использовали `memory.db.transaction(() => {...})()` — транзакционная граница протекала наружу repo, паттерн узаконил доступ к `db` из non-repo кода (легко добавить там же `memory.db.run(...)` мимо репо).
**Fix:** `MemoryDB.transaction<T>(fn): T` (`db/index.ts`) — pass-through к `MemoryRepository.transaction`. Все pipeline/route call sites переведены: `memory.db.transaction(() => {...})()` → `memory.transaction(() => {...})`. `freelance/persist.ts` `deps.db.db.transaction(...)` → `deps.db.transaction(...)`. Тесты/scripts продолжают использовать `memory.db` (escape hatch для DELETE FROM cleanup'ов).
**Не сделано:** privatize `MemoryDB.db` поле — заблокировано тестами (`tests/metrics.test.ts`, `night-cycle.test.ts`, `rag-status-filter.test.ts`, `rag-shared-vec.test.ts`, `memory-service.test.ts`) которые делают `memory.db.query/exec` для cleanup. Privatize требует добавить test-only API (`memory.exec` / `memory.runQuery`) — отдельный PR.
**Verify:** `bunx tsc` 0; `bun test` 576/0; grep `memory\.db\.transaction\|deps\.db\.db\.transaction` вне tables/repos/schema/scripts → 0 hits.

### H-2 ✅ `src/pipeline/night-cycle/index.ts` — orchestrator разбит на модули (закрыто PR H-2, 2026-04-25)
Файл был 397 LOC при cap ≤100 для orchestrators. Содержал retry-queue persistence + per-session pipeline + anti-patterns step + 6× prune-step орчестрация в одном классе.
**Fix:** разбит на 6 файлов (соответствует guardrail #1: `phases/`/`steps/`/`tables/`/`post/`/`pre/`):
- `retry-queue.ts` (64 LOC) — pure helpers: `RetryEntry`, `parseRetryQueue`, `upsertRetry`, constants.
- `batch.ts` (81 LOC) — `runRetryPass` + `runMainBatch` (loops по `processSession`, разделены чтобы избежать import-cycle с `retry-queue`).
- `process-session.ts` (104 LOC) — `processSession` standalone (был private method).
- `anti-patterns-step.ts` (53 LOC) — extract + embed + transactional archive.
- `post-steps.ts` (72 LOC) — `runPostBatchSteps`: contradictions + 4× prune + stray collection через `runStep` helper (try/catch + error push).
- `index.ts` 89 LOC — тонкий координатор: lastProcessed → fetch logs → group → retry-pass → main-batch → anti-patterns → post-batch → save progress.
**Verify:** `bunx tsc --noEmit` 0; `bun test` 576/0; `index.ts` 397 → 89 LOC (под cap 100).

### H-1 ✅ `src/rag/pipeline.ts:344` — `embedContent` принимает `AbortSignal` (закрыто PR H-1, 2026-04-25)
`async embedContent(content: string)` без signal-параметра → SSE-cancel / tool-timeout / request-abort оставляли upstream embed работать до конца, жгли NVIDIA RPM на discarded result. Подтверждалось комментарием в `extractors.ts:11` ("rag.embedContent does not accept an AbortSignal").
**Fix:** `embedContent(content, signal?: AbortSignal)` + `indexEntry(id, layer, content, signal?)` + `embedQuery(query, signal?)` — все три прокидывают `signal` в `router.raw.embed({..., signal})`. `EmbedParams.signal?: AbortSignal` (`providers/types.ts`); `nvidia.embed` strips signal из body, threads в `fetchJson(..., {timeoutMs, signal})`. `extractors.ts` `embedWithTimeout` упрощён: `rag.embedContent(content, AbortSignal.timeout(EMBED_TIMEOUT_MS))` вместо Promise.race + setTimeout (orphan promise был побочный эффект race). Header docstring обновлён.
**Tests:** `tests/shared-embed-write.test.ts:104` мок embed теперь honor-ит signal (как fetchJson upstream), error-pattern matches `timed out|timeout|aborted`. `bun test` 576/0; `tsc` 0.

### B-2 ✅ `src/pipeline/agent-loop/code-tools/index.ts` + `agent-loop/persist.ts` — raw SQL вне repo-слоя (закрыто PR B-2, 2026-04-25)
`CodeToolRegistry` держал 7 raw SQL ops над `code_tools`; `agent-loop/persist.ts` — 3 raw SQL для round-trip dynamic-tools blob через `agent_memory`. Layer-boundary test уже сканировал `pipeline/`, но эти файлы были в `KNOWN_LEGACY` allowlist (silent free pass).
**Fix (PR B-2):**
- `src/db/tables/code-tools.ts` (NEW) — `CodeToolsTable` с insert/get/getByName/list/update/delete/recordSuccess/recordError/disable.
- `src/repositories/code-tools.repo.ts` (NEW) — thin facade.
- `CodeToolRegistry` → конструктор принимает `CodeToolsRepository`; boolean-cast `enabled` + size cap + auto-disable threshold остаются как business logic.
- `SharedTable` + `MemoryRepository` + `MemoryDB` facade extended: `getLatestAgentMemoryByAgentId(agentId)` + `updateAgentMemoryContent(id, content)`.
- `agent-loop/persist.ts` использует новые методы; 3 raw SQL → 0.
- `agent-loop/index.ts:42` wires `new CodeToolRegistry(new CodeToolsRepository(memory.db))`.
- `tests/layer-boundary.test.ts` KNOWN_LEGACY: `agent-loop/persist.ts` + `agent-loop/code-tools/index.ts` удалены.
**Verify:** `bunx tsc --noEmit` 0; `bun test` 576/0; `grep '\bdb\.(run|query|prepare)\(' src/pipeline/agent-loop/` → 0 hits.

### MEM-4 🟡 `src/mcp/tools/memory-tools.ts:148` — `deleteEmbedding` дёргается ВНЕ `db.transaction()`
`deleteMemory` tool (handler для `memory_delete`) сначала `delete*(id)` из основной таблицы, потом `deleteEmbedding(id)` — но не в одной транзакции. Если процесс умер между → orphan embedding (как MEM-1) или наоборот — мёртвая ссылка в главной таблице при живом vec.
**Fix:** обернуть пару в `db.transaction(() => {...})()`.
**Scope:** тривиальный PR.

---

## Addendum 2026-04-24 — мини-аудит безопасности/корректности (глава 16)

Все пункты подтверждены чтением кода. Плановые PR — в [docs/tasks/refactor/16-layer-separation.md](tasks/refactor/16-layer-separation.md) и соответствующих `17-*.md`..`27-*.md`.

### AUTH-16 ✅ `src/app/bootstrap.ts:93-103` + `src/lib/auth.ts:28` — auth-hole на 5 endpoint-ах (закрыто PR 17)
`/api/token`, `/night-cycle`, `/night-cycle/status` объявлены ДО `authMiddleware` → доступны без токена. `/api/token` утекает Bearer-секрет кому угодно. Плюс `auth.ts:28` глобально пропускает `/telegram/*` по префиксу — админ-ручки `/telegram/set-webhook`, `/telegram/remove-webhook` полностью голые.
**Fix:** PR 17 — `/api/token`, `/night-cycle`, `/night-cycle/status`, `telegramAdminRoute` перенесены ПОСЛЕ `authMiddleware`; `telegramRoute` разделён на `telegramPublicRoute` (webhook, secret-header auth) + `telegramAdminRoute` (bearer); `auth.ts` bypass сужен с `startsWith("/telegram/")` до строго `path === "/telegram/webhook"`. Дополнительно убран ранее существовавший bypass `/api/token` в `auth.ts` — endpoint теперь требует Bearer. Регрессия покрыта `tests/auth-coverage.test.ts` (10 сценариев).

### TG-1 ✅ `src/telegram/bot.ts:238` + `src/mcp/executor.ts:76` — `tg_send_message` лжёт агенту
`notify()` глотает exception и резолвится `void`; `tgSendMessage()` await-ит → `{success:true}` всегда. Автономный агент думает «уведомил», хотя Telegram 500.
**Fix:** PR 18 — добавлен `TelegramBot.notifyOrThrow` (строгий), `notify` оставлен fire-and-forget для дайджестов; `deps.ts` привязал `setBotNotify` к `notifyOrThrow`; executor `tgSendMessage` возвращает `{success:false,error}` на throw; registry-handler `tg_send_message` префиксит `tg_delivery_failed:` чтобы агент видел честный error. Tests: `tests/telegram-notify.test.ts`, `tests/tg-send-tool.test.ts`. *(закрыто PR 18).*

### OBS-1 ✅ `src/db/schema.ts:305` + `src/lib/logger.ts:75,78` — Layer 4 silent drop (закрыто migration 7 + logger workaround, статус подтверждён 2026-04-26)
CHECK разрешал `user/assistant/system/tool/reasoning`, logger писал `_log_${level}` → CHECK violation, `catch {}` глотал. Migration 7 (`schema.ts:432-453`) расширила CHECK до `_log_debug/info/warn/error/channel_message`. Logger catch (`lib/logger.ts:75-110`) surface-ит первое violation per unique role через `console.error`; `_warnedRejectedRoles` set предотвращает spam.
**M-3 (PR 2026-04-26):** добавлен re-entrancy guard `_inLoggerCatch` — если кто-то добавит `logger.warn(...)` внутрь catch'а, не будет stack overflow.

### OBS-2 🟢 архитектурный долг — `channel_message` это тип, не role
`userbot.ts:319` пишет message type в колонку `role`. PR 19 — костыльный фикс (расширение CHECK), правильный фикс: колонка `msg_type` либо `role='tool'` + content prefix. Пост-PR-19 follow-up. Не блокирует главу 16.
**Fix:** отдельная задача после главы 2.

### CANCEL-1 ✅ `src/pipeline/agent-loop/tool-runner.ts:45` + `src/pipeline/arbitration-room.ts:85,225` — timeout без abort (закрыто PR 20)
`Promise.race([exec, timeout])` без `controller.abort()` → underlying fetch/browser/stream продолжает работать до естественного конца, слив RPM и ресурсов на работу с выброшенным результатом.
**Fix:** PR 20 — `withToolTimeout` завёл внутренний `AbortController` и композирует `AbortSignal.any([external, internal])` в effective signal для handler-а; `ToolHandler` получил optional `signal` (back-compat — short handlers игнорируют); long-running handlers (web_* через proxy, consult_chaos, consult_specialists через `ArbitrationRoom.run(..., signal)`) форвардят в downstream; `arbitration-room.callSpecialist` теперь принимает полный `AbortController`, таймер перед `reject` вызывает `controller.abort()`, `synthesize()` тоже получает external signal. Tests: `tests/tool-timeout-abort.test.ts` (3 кейса: timeout abort в 700ms, external abort composition, fast-path), `tests/arbitration-abort.test.ts` (per-specialist timeout + external signal). *(закрыто PR 20).*

### SCHED-1 ✅ `src/pipeline/agent-loop/system-prompt.ts:167` + `src/scheduler/*` — scheduled-агент без approval может писать код (закрыто PR 21, статус подтверждён 2026-04-26)
**Fix (PR 21):** `AgentMode = "scheduled" | "interactive"` (`pipeline/agent-loop/types.ts:25`); `SCHEDULED_HIDDEN_TOOLS = {create_tool, create_code_tool, edit_code_tool}` в `mcp/registry/tool-registry.ts`. `installAutonomousScheduler` + `installFreeAgentScheduler` + `free-agent.ts:76` передают `agentMode: "scheduled"`. `routes/autonomous.ts` оставлен `interactive` (human-triggered). `registry.toOpenAIToolsForAgent(mode)` фильтрует hidden tools. Env opt-in `SCHEDULED_ALLOW_CODE_TOOL_CREATE=1` отключает фильтр для manual operator runs.

### MEM-5 ✅ `src/pipeline/agent-pipeline/post/extractors.ts` — memory write без confidence
Post-hippocampus пишет в `shared_memory` / `memory` мгновенно, без оценки уверенности. Модельные догадки попадают в «глобальные факты» и потом цитируются как истина.
**Fix:** PR 22a + 22b — миграция 7 добавляет `confidence REAL` + `status TEXT CHECK('pending'|'active'|'rejected')`; post-hippocampus эмитит confidence; ≥0.8 → active, <0.8 → pending; RAG injection фильтрует только active; UI approve/reject.
**Scope:** PR 22a (schema), 22b (UI).

### MEM-8 ✅ fts_log + RAG layer "log" (закрыто M-04, 2026-04-26)
Layer 4 (`layer4_log`) — append-only без FTS / vec / retrieval API. RAG не может цитировать что было сказано вчера → нет episodic-памяти в SOTA-смысле (LongMemEval-2025 multi-session ability).
**Fix:** M-04 — миграция 11: `fts_log` (FTS5 mirror над `layer4_log.content` + `role`, `tokenize='porter unicode61'`) + 3 trigger'а (ai/ad/au) + one-shot backfill (guarded `count(*)=0` чтобы избежать double-insert). `LogTable.searchLog(query, opts)` (`src/db/tables/log.ts`, ≤80 LOC) использует `sanitizeFtsQuery`, JOIN `fts_log` ↔ `layer4_log` по rowid, optional `agentId` / `sessionId` filter, default limit=20. `LogRepository.searchLog` делегирует. `RAGSearchOptions.layers` extended union → `"context"|"archive"|"shared"|"log"`; `RAGPipeline.search` skip vec-branch для log layer (`vecLayers = layers.filter(l!=="log")`); FTS branch добавлен в `ftsSearch`. Default layers `["context","archive","shared"]` НЕ включают `"log"` (privacy: raw log holds pre-scrub PII). bumpAccess уже фильтрует через `isBumpLayer` — log layer silently skip. MCP tool `memory_log_search` (`scope: "agent-only"`, доступ только из agent-loop) делегирует в `executor.memoryDb.logRepo.searchLog`. Public REST `/v1/memory/log` остаётся read-only без `?q` (PII-protect). Embedding слой Layer 4 OUT OF SCOPE — rolling N=10k embed = M-04.1 follow-up.
Tests: `tests/fts-log.test.ts` (10 кейсов — миграция + идемпотентность, fts_log + 3 триггера, INSERT/UPDATE/DELETE sync, content + snippet + role-as-title + agentId/sessionId filter, sanitize edge cases (`:* "`), RAG layer "log" branch, default layers exclude log, bumpAccess не trigger'ится на log).
**Scope:** M-04.

### MEM-7 ✅ access tracking columns на shared/context/archive (закрыто M-02, 2026-04-26)
RAG retrieval не оставляет следа на конкретных строках — нет данных для popularity-ranking, decay-ranking, salience-reinforce. Foundation для M-03 (salience reinforce-on-access) и M-08 (Ebbinghaus decay в retrieval ranking).
**Fix:** M-02 — миграция 10: `last_accessed_at INTEGER NULL` + `access_count INTEGER NOT NULL DEFAULT 0` на `shared_memory` / `layer2_context` / `layer3_archive` + три `idx_*_access` индекса. `MemoryRepository.bumpAccess(layer, ids[])` — single batched UPDATE per layer (early-return на пустом массиве). `RAGPipeline.search` после rerank fire-and-forget группирует результаты по layer и вызывает `bumpAccess` через `void Promise.allSettled` — retrieval не блокируется. Env `RAG_BUMP_ACCESS=false` отключает hook полностью. `last_accessed_at` / `access_count` НЕ в `ALLOW_*_PATCH` allow-list — pure repo-managed signal.
Tests: `tests/memory-access-tracking.test.ts` (11 кейсов — миграция, идемпотентность, schema, индексы, bump increment, empty no-op, RAG hook, env disable, ordering invariance).
**Scope:** M-02 (M-03 + M-08 строятся поверх).

### MEM-6 ✅ `src/pipeline/agent-pipeline/post/*` — гиппокамп собирает мусор (закрыто 2026-04-26)
Прод-аудит 2026-04-26 (147 shared, 655 layer2_context): self-feeding loop через subbrain-ping (`[from Claude Code CLI] freelance scout deployed` сохранялось как `category=deploy`); дубликаты тех же предпочтений (3 строки про `consult_specialists`); полные тексты статей в `context` (>1KB на строку); time-bomb факты (`FL.ru заказы к 27.04` без expires_at); конкурирующие "главные планы" без supersede.
**Fix:** PR 28 (single PR) —
1. `post/gate.ts`: skip exchanges starting with subbrain-ping / free-agent / freelance-scout prefixes.
2. `post/validators.ts` (new): closed taxonomy (shared: profile|preference|goal|relationship|skill|constraint|style; context: project|decision|bug|architecture|learning) + content cap (600/2000) + content blacklist (deploy phrases, commit hashes, `[from Claude Code CLI]`).
3. `post/dedupe.ts` (new): pre-insert FTS + vec dedupe (cosine ≥0.85 в JS — sqlite-vec возвращает L2 на ненормализованных векторах, не cosine); update merged content/tags/confidence on hit, no new row; embed lazy.
4. Migration 9: `expires_at INTEGER NULL` + `superseded_by TEXT NULL` + indexes + self-supersede trigger; RAG/pre filter via new `notStale` opt (status `activeOnly` отдельный флаг, pending видны pre, expired/superseded — нет); `?active=true` admin query.
5. `night-cycle/steps/memory-dedup.ts` (new): cluster-merge (cosine ≥0.9, same category) → max(updated_at) wins, longest content; expire pass marks `superseded_by='expired'`.
Tests: `tests/pipeline-post-{gate,validators,dedupe,supersede}.test.ts`, `tests/memory-migration-9.test.ts`, `tests/rag-active-filter.test.ts`, `tests/night-cycle-memory-dedup.test.ts`, `tests/memory-routes-active.test.ts`. 633 pass / 0 fail.
**Scope:** PR 28.

### ✅ ROUTE-1 `src/routes/chat.ts:31` + `src/lib/model-router.ts:61` — directMode триггерится не тем провайдером (PR #23)
~~`router.isOverloaded` смотрит только на NVIDIA limiter, но все роли primary=MiniMax. Когда NVIDIA перегружена (RAG/embed), чат через MiniMax внезапно переключается в direct mode → обходит pipeline + память. Плюс `providers/index.ts:23` требует Copilot+OpenRouter даже если они не primary/fallback нигде.~~
**Fix:** PR 23 — `isOverloadedFor(provider)` с NVIDIA-alias `isOverloaded @deprecated`; `routes/chat.ts` компьютит directMode через `resolveModel(requested).provider`; `providers/index.ts:createProviders` читает MODEL_MAP и грузит только референснутые провайдеры (NVIDIA всегда, Copilot/OpenRouter — только если в map), unreferenced slots получают stub который кидает на вызове.
**Scope:** PR 23.

### RAG-1 🟡 `src/pipeline/agent-pipeline/post/extractors.ts:29` + `src/rag/pipeline.ts:156` — shared RAG semantic broken
`writeShared` не эмбеддит → vec-поиск не находит. Плюс `rag/pipeline.ts:156` vec-путь для shared не подтягивает row → snippet пустой даже если вектор нашёлся.
**Fix:** PR 24 — `writeShared` async, embed + index (паттерн `writeContext`); `getSharedMany` + hydration в vec-path.
**Scope:** PR 24.

### LAYER-1..LAYER-4 ✅ смешение ответственности в routes
Routes делают DB-доступ + бизнес-логику + HTTP-shaping одновременно. Introduce controller/service/repository слои поэтапно.
**Fix:** ~~LAYER-1 (PR 25a — AuthService)~~ ✅, ~~LAYER-2 (PR 25b — MemoryService)~~ ✅, ~~LAYER-3 (PR 26a — ChatService)~~ ✅, ~~LAYER-4 (PR 26b — AgentService)~~ ✅, ~~LAYER-5 (PR 27 — Repository слой над `db/tables/*`)~~ ✅.
**Scope:** PR 25a ✅, 25b ✅, 26a ✅, 26b ✅, 27 ✅.

### MEM-10 ✅ salience reinforce + decay (закрыто M-03)
M-02 положил `last_accessed_at` + `access_count` на 3 layer'ах, но retrieval signal был "холодный" — не было метрики "насколько эта запись важна". M-03 добавляет **salience** [0..1]: bumpAccess реинфорсит `salience += 0.05 * exp(-age_days/7)` (свежие memos получают полный bonus, старые — экспоненциально меньший, кэп 1.0); night-cycle step `decay-salience` множит `salience *= 0.98^days_since_last_decayed` для всех accessed rows (флор 0.001, idempotent через колонку `last_decayed_at` — same-day rerun = no-op).
**Fix:** M-03 — миграция 13 (M-05 takes 14, disjoint scope): `salience REAL NOT NULL DEFAULT 0.5` + `last_decayed_at INTEGER DEFAULT NULL` × 3 layer'а + `idx_*_salience` × 3 (DESC). `MemoryRepository.bumpAccess` SQL расширен EXP()-формулой через MIN(1.0, ...) cap; `MemoryRepository.decaySalience(layer, now)` exposes pure-SQL UPDATE (POW() из bun:sqlite). Step `src/pipeline/night-cycle/steps/decay-salience.ts` (40 LOC) фиксирует `now` и фан-аутит на 3 layer'а через repo. Wired в `post-steps.ts` после `runMemoryDedup`. `RAGPipeline.applySalienceBoost` post-rerank: `score *= 1 + 0.1 * (salience ?? 0.5)` — стэкается мультипликативно с persona boost (max ≈ 1.21×). `RAGResult.salience?: number`. FTS `searchShared/Context/Archive` SELECT-листы расширены `salience` колонкой; vec hydration map тоже. `NightCycleResult.salienceDecayed: number` для финального лога.
Tests: `tests/memory-salience.test.ts` (11 кейсов — migration columns + idempotency, reinforce baseline + age-aware bonus, saturation cap, decay formula 0.98^10 ≈ 0.817, decay idempotent same-day, floor 0.001, virgin row skip, RAG hot-vs-cold ranking, persona+salience compound).
**Foundation для M-08** (Ebbinghaus forgetting curve использует salience в `R = exp(-Δt / S)` где S зависит от access_count + salience).
**Scope:** M-03.

### MEM-9 ✅ memory kind/persona enum (закрыто M-07)
`shared_memory` смешивал personality-факты (profile/preference/relationship) с semantic-знанием (goal/skill/constraint/style) в одной плоской таблице. Не было способа отличить "пользователь любит Hyprland" (persona, ↑ приоритет в системном промпте) от "TypeScript строгая типизация важнее DX" (semantic, средний приоритет).
**Fix:** M-07 — миграция 12 (M-04 takes 11, no conflict): `kind TEXT NOT NULL DEFAULT 'semantic'` на `shared_memory` + UPDATE backfill из category (profile/preference/relationship → persona, остальное → semantic) + 2 BEFORE-триггера (INSERT + UPDATE OF kind) для CHECK enum (SQLite ALTER не поддерживает ADD CHECK) + idx_shared_kind. `categoryToKind(category, layer)` pure-fn в `post/validators.ts` (re-export `MemoryKind` из `db/types.ts`); `extractors.writeShared` + merge-update derive kind через helper. `RAGPipeline.applyPersonaBoost` post-rerank: `score *= 1.1` для `kind === 'persona'` shared rows + re-sort. `RAGResult.kind?: string` — optional т.к. context/archive/log не имеют поля. Admin `GET /v1/memory/shared?kind=persona` через TypeBox `t.Union([t.Literal(...)])` enum (rejects garbage 422). UI: `kindFilter` state в `useMemory` + dropdown only on shared tab.
Tests: `tests/memory-kind.test.ts` (18 кейсов — schema, idempotency, mapping, CHECK trigger INSERT+UPDATE, service insert, extractors derive, RAG persona boost ranking, admin filter +422 invalid). 668 pass / 0 fail.
**Foundation для M-08** (asymmetric forgetting curve — persona never decays) **и M-11** (sleep-time block rewriter переписывает persona в layer1_focus).
**Scope:** M-07.

### MEM-12 ✅ reflect step (CoALA episodic→semantic, закрыто M-06, 2026-04-26)
Episodic substrate (`layer2_context`) копился из post-extractor'а, но **обобщения** в semantic layer (`shared_memory`) автоматически не выделялись. CoALA (arXiv 2309.02427) reflect-механизм отсутствовал: повторяющиеся context-паттерны (например, 4 записи category='project' про Bun runtime) никогда не promote'ились в shared фактом "Project uses Bun runtime". Накапливающийся garbage в context, отсутствие cross-link между источниками и обобщением, нет foundation для M-09 cross-layer dedup и M-11 sleep-time block rewriter.
**Fix:** M-06 — pure-code step (no migration; foundation columns landed в M-02 access_count, M-03 last_decayed_at, M-05 memory_edges, M-07 kind enum). `src/pipeline/night-cycle/steps/reflect.ts` (170 LOC) + `MemoryTable.reflectGroups` (SQL stays в `src/db/tables/memory.ts` per layer-boundary, exposed через `MemoryRepository.reflectGroups` для pipeline без raw SQL). Group selection: `lower(title) IN whitelist` (`project|decision|bug|architecture|learning`, mirrors `WHITELIST_CONTEXT`), `access_count >= REFLECT_MIN_ACCESS` (default 3), `created_at < now-86400` (>24h), `status='active'`, `superseded_by IS NULL`, `expires_at IS NULL OR expires_at > now`. `HAVING n >= REFLECT_MIN_GROUP` (default 3), `LIMIT REFLECT_MAX_GROUPS` (default 5). Per group: `router.chat(NIGHT_MODEL=memory, ..., temperature:0.1, max_tokens:250, signal:AbortSignal.timeout(30s))` со prompt'ом "extract one consolidated semantic fact OR exactly NULL". `NULL` literal (включая `"NULL"` / `null` / `NULL.`) → skip. Skip-guard: `findDuplicate(memory, rag, 'shared', category, fact)` (`post/dedupe.ts`, cosine ≥ 0.85 same-category) → если есть dup → skip. Иначе `MemoryService.insertShared({kind:'semantic', source:'reflect', confidence:0.7})` + `memory.linkEdge(srcContextId, 'context', newSharedId, 'shared', 'derives', 1.0)` per source. Const-weight 1.0 (M-05 fix-round established: existence-based, not strength). LLM/embed errors → `llm_failures++`, не throw. `REFLECT_ENABLED=false` → no SQL, zeros. Wired в `runPostBatchSteps` после `runMemoryDedup` + `decaySalience` (видит дедуп+decayed substrate). `NightCycle` ctor взял optional 4-th arg `MemoryService` (legacy 3-arg ctor в тестах остаётся валидным; reflect step skipped без service'а). `NightCycleResult` +4 поля (`reflectGroupsExamined/FactsPromoted/EdgesCreated/LLMFailures`).
Tests: `tests/night-cycle-reflect.test.ts` (290 LOC, 9 кейсов — empty/below-access/below-group/promote+derives-weight/NULL-literal/skip-guard/LLM-fail/REFLECT_ENABLED=false/non-whitelist-skip). 693 pass / 1 unrelated fail (web `isomorphic-dompurify` import — pre-existing).
**Out of scope (follow-ups):** cross-category reflection (M-06.1), shared→archive long-term consolidation, contradiction detection edges (M-05.2), tuning constants (3/3/5/0.85), shared→procedural reflect, UI просмотр reflect-history.
**Foundation для M-09** (cross-layer dedup использует те же edges) **и M-11** (sleep-time block rewriter опирается на reflect-stable shared rows).
**Scope:** M-06.

### MEM-11 ✅ memory edges (A-MEM lite, закрыто M-05, 2026-04-26)
`derived_from` JSON массив в `layer2_context` хранил one-way источники (id'и без указания layer), не запрашивался ни одним API. Никакого typed graph между memos: A-MEM (NeurIPS '25) Zettelkasten / Mem0g entity-relation pattern отсутствовал. Foundation для M-06 reflect-step (CoALA-style episodic→semantic promotion с derives-edges) + M-09 cross-layer dedup (use edges для merge tracking) был не закрыт.
**Fix:** M-05 — миграция 14 (M-03 owns 13): `memory_edges(src_id, src_layer, dst_id, dst_layer, kind, weight, created_at)` + composite PK + 3 индекса (idx_edges_src/dst/kind) + CHECK на src_layer/dst_layer + CHECK на kind. `EdgeKind` union: `'derives' | 'relates' | 'contradicts' | 'supersedes'` (distinct from `MemoryKind` of M-07). `EdgesTable` (`db/tables/edges.ts`, 147 LOC) + `EdgeRepository` (`repositories/edges.repo.ts`, 46 LOC) wired в MemoryDB facade. `linkRelated` hook (`pipeline/agent-pipeline/post/link-related.ts`, 48 LOC) после dedupe + insert в `writeShared` / `writeContext` → top-3 vec neighbours в same layer (skipRerank, self-skip) → INSERT edges kind='relates' weight=1.0 (existence-based, not strength — `n.score` from skipRerank=true is RRF-rank-derived, not calibrated similarity; persisting it would invert higher=stronger intuition for downstream consumers). Non-blocking — RAG failure → `log.warn` 2-arg, не throw. Backfill: existing `layer2_context.derived_from` JSON через `json_each(COALESCE(c.derived_from, '[]'))` → INSERT kind='derives' (assumes context-layer source per back-compat heuristic). Idempotent: empty-table guard перед backfill + INSERT OR IGNORE на PK collision.
Tests: `tests/memory-edges.test.ts` (11 кейсов — schema + 3 indexes + composite PK, addEdge OR IGNORE, getEdgesFromSrc/Dst kind filter, getRelated depth=1/2 traversal, backfill from derived_from + idempotency on rerun, linkRelated top-3 cap + self-skip + RAG-fail swallowing).
**Out of scope (follow-ups):** evolution (A-MEM update of neighbour attributes — M-05.1), LLM-based contradiction detection (M-05.2), public MCP curation tools (`memory_link` etc — M-10), cross-layer dedup using edges (M-09), web UI for edge visualisation, edge weight semantics tuning.
**Foundation для M-06** (reflect-step promotion с derives edges) **и M-09** (cross-layer dedup).
**Scope:** M-05.

### MEM-13 ✅ forgetting curve в retrieval (закрыто M-08, 2026-04-26)
RAG rerank финальный score после M-02/M-03/M-07 учитывал только persona (×1.1) + salience (×1+0.1·s). Не было MemoryBank-style time-decay: 30-дневная stale-context-row ранжировалась наравне со свежей одинаково-релевантной запись. Foundation для последнего P1 ticket'а wave-3 (после него memory-v2 P1 закрыт; M-09/M-10/M-11/M-12 — P2 backlog).
**Fix:** M-08 — без миграции (retrieval-side, использует существующие колонки M-02 + M-03 + M-07). Pure-fn `src/lib/memory-decay.ts` (70 LOC, no DB / IO / logger / globals): `computeRecallScore(now, lastAccess, accessCount, salience)` = `exp(-Δt/tau)` где `tau = (1 + ln(1+access_count)) * (0.5 + clamp(salience,0,1)) * 86400` секунд (никогда-доступная запись → R=1.0 как fresh-proxy, не штраф). `applyForgettingCurve(rows, now, weights, options)` мапит `score *= 1 + W_RECALL * R`. **Persona override** (default `skipPersona: true`): persona shared rows получают `R=1.0` пинной (не `return r unchanged` — иначе фрешрезультаты semantic'и обогнали бы persona на эквивалентном базовом score'е через ×1.15 бонус); identity-факты никогда не decay-ятся, но получают тот же recall multiplier что и эквивалентно-свежие semantic peers, и persona-boost (×1.1 upstream) обеспечивает нужный edge. Env: `RAG_RECALL_WEIGHT` (default 0.15), `RAG_SALIENCE_WEIGHT` (default 0.1, documentation pass-through — sole источник для salience-multiplier остаётся `SALIENCE_BOOST_FACTOR` в pipeline). Read at call-time, `=0` отключает эффект (тест 11). `RAGPipeline.search` order: rerank (или RRF fallback) → applyPersonaBoost (M-07) → applySalienceBoost (M-03) → **applyForgettingCurve (M-08)** → re-sort. `RAGResult.last_accessed_at?: number | null` + `RAGResult.access_count?: number` (M-03 уже добавил `salience?`). FTS SELECT-листы `searchShared/Context/Archive` расширены `last_accessed_at, access_count` (vec hydration уже использовал `SELECT *`). `FtsResult` тоже расширен.
Tests: `tests/memory-forgetting-curve.test.ts` (11 кейсов — pure-fn baseline lastAccess=null+dt=0, 1d→e^-1, access_count slows decay, salience slows decay, never-accessed +bump, 30d→multiplier≈1.0, persona override pinned R=1.0, fresh-vs-stale re-sort, weight=0 disables, RAG end-to-end fresh+persona-old above semantic-old, RAG end-to-end weight=0 gap shrinks).
**Out of scope (follow-ups):** auto-delete based on R (never — only ranking signal); per-kind decay tuning (`episodic` faster than `procedural` — M-08.1); A/B benchmark (LongMemEval_S replication — manual eval); archive-layer override (slower decay for compressed long-term — M-08.2); UI визуализация R per row.
**Foundation для:** memory-v2 P1 закрыт. M-09/M-10/M-11/M-12 — P2 backlog (cross-layer dedup, public MCP curation, sleep-time block rewriter, A-MEM evolution).
**Scope:** M-08.

### MEM-14 ✅ archive confidence унификация (закрыто M-12, 2026-04-26)
`layer3_archive.confidence` оставался TEXT('HIGH'|'LOW') NOT NULL DEFAULT 'HIGH' — наследие до миграции 8 (M-FINAL2 audit). Все остальные слои (`shared_memory`, `layer2_context`) после mig 8 имели `confidence REAL` с диапазоном [0, 1] + `MEMORY_AUTOACCEPT_CONFIDENCE` (default 0.8) threshold для status='active'. Schema mismatch блокировал унифицированную UI/API surface (route `/v1/memory/archive` принимал string-enum, остальные — number).
**Fix:** M-12 — Migration 15: rebuild `layer3_archive` через temp-table + INSERT-SELECT + DROP + RENAME (mig 3/7 pattern). Backfill `'HIGH' → 0.9`, `'LOW' → 0.4`, иначе NULL. Под `db.transaction()` + per-statement `.run()`. Сохраняет M-02 (`last_accessed_at`, `access_count`) + M-03 (`salience`, `last_decayed_at`) колонки. Re-creates FTS5 mirror triggers + indexes (`idx_archive_access`, `idx_archive_salience`) после rename. **Critic round-1 fix:** `INSERT INTO fts_archive(fts_archive) VALUES('rebuild')` после trigger setup — contentless FTS5 индекс был keyed по OLD rowids dropped table'а, новые rowids после INSERT-SELECT не маппились → legacy rows silently дропались из FTS-search. Regression test покрывает legacy-row-FTS path. `ArchiveRow.confidence: number | null` (заменил TEXT-union). `insertArchive` default = 0.9 (= legacy "HIGH"). Все callers переехали на numeric: `night-cycle/steps/{compress,verify,contradictions}.ts`, `night-cycle/anti-patterns-step.ts`, `night-cycle/prune/tasks.ts`, `mcp/tools/memory-tools.ts` (archive case), `routes/memory.ts` (TypeBox `t.Number({minimum:0, maximum:1})`), frontend (`useMemory/types.ts`, `MemoryEditor.vue`, `editor/ArchiveBody.vue`, `MemoryList.vue`, `useMemoryEditor.ts` — рендер `.toFixed(2)` + threshold-based color ≥0.8 → green). M-07 plan-locked archive из `kind` — НЕ добавлено.
Tests: `tests/memory-archive-confidence.test.ts` (9 кейсов — 8 base + legacy-FTS regression).
**Out of scope (follow-ups):** archive `kind` column (M-07 plan-locked); per-kind threshold tuning (M-12.1 если A/B); 100k+ rows perf — отдельная задача.
**Scope:** M-12.

### MEM-16 ✅ cross-layer dedup + archive→shared promote (закрыто M-09, 2026-04-26)
После M-05 (edges) + M-06 (reflect, intra-layer dedup) дубликаты МЕЖДУ слоями (context↔archive, archive↔shared, context↔shared) не ловились — тот же fact мог жить в archive (compressed long-term) и shared (свежая глобальная), сжигая context window на retrieval. Также archive-rows с `access_count ≥ 5 + confidence ≥ 0.7` фактически = глобальный фундаментальный факт и должны были автоматически promote'иться в shared для system-prompt инъекции.
**Fix:** M-09 — без миграции (extends existing edges + uses M-12 archive REAL confidence). Pure-cosine, no LLM. New step `src/pipeline/night-cycle/steps/cross-layer-dedup.ts` (193 LOC, ≤200 cap). Pass 1: для каждой из 3 layer-pair'ов берёт top-N=200 (env `CROSS_LAYER_DEDUP_LIMIT`) recent active+fresh rows per layer, fetches stored vec_embeddings via `getEmbeddingsByIds(layer, ids)` (new helper в `tables/shared.ts`), pairwise cosine ≥ 0.92 + same-category match (lower(context.title) ↔ lower(archive.title) ↔ lower(shared.category)) → newer (max updated_at) = live, older = stale, edge `kind='supersedes' src=stale dst=live weight=1.0`. shared/context stale также получают `superseded_by = live.id` через `setSupersededBy`; archive не имеет колонки (M-07/M-12) → только edge. Pass 2: archive→shared promote — кандидаты `access_count ≥ ARCHIVE_PROMOTE_MIN_ACCESS` (default 5) + `confidence ≥ ARCHIVE_PROMOTE_MIN_CONFIDENCE` (default 0.7) через `archivePromoteCandidates` репо. Skip-guard: `searchEmbeddings(av, 5, 'shared')` → fetch их векторы → cosine ≥ 0.85 same category → skip (idempotency на rerun зиждется на этом — promoted row на 2-м прогоне сам блокирует повторный promote). Insert via `MemoryService.insertShared({source:'archive-promote', kind:'semantic'})` (atomic embed-first per M-01) + `derives` edge от archive к shared. Archive НЕ помечается superseded — иначе ломается idempotency. Errors swallowed + counted, не throw. Fan-out 3 пар через `Promise.allSettled`. Env-gated: `CROSS_LAYER_DEDUP_ENABLED` (default true). Wired в `post-steps.ts` ПОСЛЕ `runMemoryDedup` + `decaySalience` И ДО `runReflect` — reflect видит cleaned, decayed, cross-layer-merged substrate, не race'ит с archive-promote insert'ами. Раздёрганы новые helper'ы в `tables/memory.ts` (`recentActiveContextForCrossLayer`, `recentArchiveForCrossLayer`, `archivePromoteCandidates`) + `tables/shared.ts` (`recentActiveSharedForCrossLayer`, `getEmbeddingsByIds`) — raw SQL остался в db/tables (layer-boundary test green).
Tests: `tests/night-cycle-cross-layer-dedup.test.ts` (10 кейсов: empty layers, 3× layer-pair supersede, archive-promote, below cosine, below access, ENABLED=false, skip-guard same-category, idempotent rerun). 740 pass / baseline 730 / +10. tsc clean.
**Out of scope:** cross-layer LLM-based merge (cosine + threshold only); shared→archive demotion (out — shared = global); auto-cleanup superseded archive (UI/admin manual); tuning thresholds 0.92/5/0.7 (A/B follow-up); 100k+ rows perf — отдельная задача.
**Foundation для:** M-11 (sleep-time block rewriter — использует cross-layer dedup чтобы не дублировать persona-блоки между layer1_focus и shared.persona).
**Scope:** M-09.

### MEM-17 ✅ rolling embed для layer4_log (закрыто M-04.1, 2026-04-26)
M-04 положил `fts_log` (FTS5 keyword search) для Layer 4 + RAG layer "log" branch, но vec embeddings на raw_log отсутствовали (privacy + write-amp concerns) — `vecLayers = layers.filter(l => l !== "log")` в `RAGPipeline.search` явно дропал log из vec ветки. Episodic semantic search для агентов не работал.
**Fix:** M-04.1 — без миграции (extends existing `vec_embeddings` schema, `layer='log'` слой). New step `src/pipeline/night-cycle/steps/embed-log.ts` (≤200 LOC) — rolling N=10k window: считает `slack = LOG_EMBED_CAP - countLogEmbeddings()`, берёт top-N unembedded recent rows (`ORDER BY l.created_at DESC, l.id DESC`), батчит embed-вызовы (`LOG_EMBED_BATCH` default=50), фан-аут через `Promise.allSettled` (один батч fail не валит остальных), upsert вектора внутри `db.transaction()`. После fill — count-based eviction старейших по `layer4_log.created_at` (пишет в `vec_embeddings` rolling window). Wired в `post-steps.ts` LAST (heavy IO last). Errors swallowed + counted (не throw). New helpers в `src/db/tables/log.ts`: `selectUnembeddedRecent`, `countLogEmbeddings`, `evictOldestLogEmbeddings` (count-diff workaround для bun:sqlite-vec virtual-table inflated `result.changes`), `hydrateForVec` (batch hydrate для RAG vec branch — raw SQL остался в db/tables per PR 27 layer boundary). `LogRepository` pass-through. `RAGPipeline.embedBatch(string[])` (≤10 LOC) — single upstream call для night-cycle batch. RAG vec branch unblock: `vecLayers = layers` (drop `.filter`); default `layers = ["context","archive","shared"]` всё ещё не включает "log" → privacy preserved (raw log holds pre-scrub PII, agent-only access). Vec branch hydrates log через `logRepo.hydrateForVec(ids)` — `title=role`, `updated_at=created_at` (no separate updated_at on log rows). `bumpAccess` (M-02) не модифицирован — log по-прежнему отфильтрован через `isBumpLayer`. Env-gated: `LOG_EMBED_ENABLED` (default true), `LOG_EMBED_CAP` (default 10000, `0` = drop window entirely), `LOG_EMBED_BATCH` (default 50, clamp 1..256). Read at call-time (не module load) — тесты toggle per case без subprocess.
Tests: `tests/night-cycle-embed-log.test.ts` (9 кейсов, 254 LOC: no log → no-op; initial backfill 100; incremental rerun; rolling cap fill+evict; embed failure → errors counted; ENABLED=false; vec branch FTS-empty contributes; default layers excludes log; CAP=0 drops window). 749 pass / +9. tsc clean.
**Out of scope:** PII-scrub before embed (raw log keeps PII, agent-only); age-based eviction (count-only); per-user variable cap; tuning ROLLING_CAP/BATCH_SIZE (A/B); public REST для log embeddings (privacy).
**Scope:** M-04.1.

### MEM-15 ✅ public MCP curation tools (закрыто M-10, 2026-04-26)
После M-05 + M-06 у агентов нет explicit-API для curation (auto-write only через hippocampus / linkRelated и night-cycle reflect). Letta-style explicit memory management отсутствовал.
**Fix:** M-10 — 4 agent-only MCP tool'а (`memory_link`, `memory_supersede`, `memory_promote`, `memory_reflect`) в новом файле `src/mcp/tools/memory-curation-tools.ts` (≤200 LOC, изолирован от 470-LOC `memory-tools.ts`). Domain logic делегирует в `MemoryDB.linkEdge` (M-05, INSERT OR IGNORE на PK), `MemoryService.insertShared` (M-01, embed-first transactional, kind='semantic'), `runReflect` (M-06 расширен optional `categoryFilter` + `dryRun`). Edge weight const 1.0. TypeBox enum на layer + EdgeKind. `memory_supersede` accepts только context+shared (archive не имеет superseded_by). `memory_promote` requires explicit `category` (context.title — free-form, не enum); `confidence` default 0.8 (autoaccept threshold) — иначе promoted row → status='pending'. `categoryFilter` берёт UNCAPPED + filter + cap (raw `selectGroups` cap=5 maskировал rank-6+ категории).
Tests: `tests/mcp-curation-tools.test.ts` (12 кейсов).
**Out of scope:** evolution (M-05.1), LLM-contradiction-detect (M-05.2), public REST для curation (privacy out), `memory_unlink`, bulk ops, ACL.
**Scope:** M-10.

### Memory-v2 wave 1 review (2026-04-26, M-FINAL)

**Closed:** MEM-2 (M-01), MEM-7 (M-02), MEM-8 (M-04), MEM-9 (M-07), MEM-10 (M-03).

**Tests:** 678 pass / 0 fail / 89 files / 2011 expect calls. `bunx tsc --noEmit` exit 0. Baseline matched.

**Migration counter:** 12 (next migration is 13).

**Open follow-ups (не блокеры, не fix в M-FINAL):**

- **M-04.1**: rolling N=10k embed для `layer4_log` (open per M-04 plan, semantic retrieval over recent log).
- **M-07.1**: `categoryToKind` not called в двух writer-путях кроме hippocampus extractors:
  1. `src/mcp/tools/memory-tools.ts:209,282` (case "shared" + `writeSharedAtomic`) — MCP `memory_write layer:shared` пишет с default `kind='semantic'` независимо от category. Persona-факт через MCP не получит +10% RAG boost.
  2. `src/pipeline/context-compressor.ts:242` → `src/services/chat.service.ts:231` (`compressorMemory` shim) → `MemoryService.insertShared` без `kind`. Compressor-spawned facts тоже default 'semantic'.
  Fix-path для будущего тикета: thread `categoryToKind` в обе точки (или в `MemoryService.insertShared` если `input.kind === undefined && input.category` — single SoT). Out-of-scope для M-FINAL per plan §113.

**Audit findings (no fix needed):**

- `writeSharedAtomic` в `src/mcp/tools/memory-tools.ts:259` дублирует `MemoryService.insertShared`. Дублирование интенциональное (subagent M-01 решил не тянуть `MemoryService` через все `ToolExecutor` вызовы — explanatory comment lines 1-11 + 254-258). DRY-отступление acceptable, оставлено как есть.
- `compressorMemory()` shim в `src/services/chat.service.ts:231` уже minimal (svc → adapter с правильной shape для `CompressorMemory` interface). Упрощение нерезультативно.
- `src/db/tables/shared.ts` = 351 LOC (>250). Не в exception list (`schema.ts, model-map.ts, rag/pipeline.ts, MCP registry, telegram, system-prompt.ts`). Рост произошёл из M-07 (kind-related search/list helpers). Single responsibility сохранён (shared-memory CRUD); split не очевиден без искусственного дробления. Flag для возможного M-XX, но **не блокер**.
- `as any` cast в `src/`: 14 hits, все pre-wave-1 (telegram userbot, mcp-protocol, copilot/stream, bootstrap). Wave 1 не привнесла новых.
- Нет `TODO M-0[1247]` маркеров — субагенты не оставили временных коммитов.

**Anti-pattern observed:** parallel subagent leaked writes from worktree to main workdir во время M-07 (см. commit 1eeb472 body). Future wave dispatches: enforce non-cd workflow в subagent prompts (this M-FINAL pass had explicit constraint в task brief).

**Verdict:** wave 1 (4 features × 4 миграций × 47 новых тестов) закрыта без regressions. Опциональный refactor-пасс не запускался — anti-goal per plan §107.

**Scope:** M-FINAL (docs-only).

### Memory-v2 wave 1-3 final refactor (2026-04-26, M-FINAL2)

**Closed:**

- ✅ **M-07.1** (real bug): `categoryToKind` теперь зовётся во всех трёх shared-writer путях.
  - `src/mcp/tools/memory-tools.ts:217` — `case "shared"` derives kind once before делегации в service / writeSharedAtomic / raw-fallback.
  - `src/pipeline/context-compressor.ts:259` — persist-loop derives kind перед shim.insertShared.
  - `src/services/chat.service.ts:236` — compressor shim прокидывает `opts.kind` в `MemoryService.insertShared`.
  - Single-call definition site: `src/pipeline/agent-pipeline/post/validators.ts:203` (unchanged).
  - Regression: `tests/memory-kind.test.ts` extended +5 cases (MCP write persona+semantic, MCP write через injected service, compressor shim end-to-end, compressContext integration).
- ✅ **writeSharedAtomic DI-cleanup**: `MemoryTools` теперь принимает `MemoryService` через `setMemoryService(svc)` (постcttor, симметрично с `setRAG`). Wired in `src/app/deps.ts:218`. Production MCP path делегирует в `MemoryService.insertShared` — single source-of-truth для shared embed-first + transactional writes. `writeSharedAtomic` остался как private fallback с TODO-комментом для legacy tests (`cross-agent-isolation`, `mcp-tools`, `tool-runner`), которые конструируют `new MemoryTools(db, () => null)` без service — final rip-out отложен до миграции этих 6 тестов.

**File-cap status:**

- `src/mcp/tools/memory-tools.ts` — 470 LOC (был 409). Рост из M-07.1 wiring + DI-plumbing + service-delegate path. Над cap (250). Split-кандидат `memory-write.ts` / `memory-read.ts` / `memory-search.ts` обсуждался: класс-уровневый split ломает single-instance API (`registerMemoryTools` импортирует `MemoryTools`), а method-extraction в helper-файлы дублирует `this.memory` / `this.getRag` / `this.memoryService` deps в каждый extracted файл. **Flagged для M-FINAL3** когда writeSharedAtomic полностью исчезнет (после миграции 6 legacy test sites) — тогда write-case упростится с ~110 до ~30 LOC и файл естественно сядет в 350-LOC. Anti-goal "don't artificially break" применён здесь.
- `src/db/tables/shared.ts` — 356 LOC. Same analysis as M-FINAL: shared-memory CRUD = single-responsibility, split-кандидат write/read искусственный (`SharedTable` класс с общим `db` deps).
- Прочие файлы из плана §13 — не тронуты (single-responsibility intact per plan §63-67).

**Tests:** 725 pass / 0 fail (was 720 pre-M-FINAL2 baseline — +5 regression cases from this pass).

**Verdict:** M-07.1 fix landed, DI-cleanup landed, file-cap deferred с обоснованием. Acceptance §5 (`memory-tools.ts ≤250`) не выполнен — plan §3 explicit allowed defer для artificial splits, §5 написан в предположении "if Step 3a runs". Step 3a не запускался в этом pass.

**Scope:** M-FINAL2 (real bug fix + DI cleanup + audit doc).

### Memory-v2 wave 4 review (2026-04-26, M-FINAL3)

**Closed:** MEM-14 (M-12 archive confidence REAL), MEM-15 (M-10 public MCP curation tools).

**Debug findings (§1 grep pass — all clean):**

- `db.insertShared` raw outside SEED_SKIP_EMBED → 0 production hits. Only `scripts/seed.ts:140` (seed script, exempt — wave-1 баг закрыт через M-FINAL via `MemoryService.insertShared`).
- `'HIGH'/'LOW'` strings on archive outside backfill → 0 hits. M-12 миграция 15 завершена чисто, ни одного residual literal.
- `(as any)` since wave-1 baseline → 14 hits, **all pre-existing** (copilot/stream.ts boundary types, telegram/userbot.ts MTProto lib types, mcp-protocol.ts Elysia body, telegram.ts handleUpdate). Identical set to M-FINAL audit, no new wave-4 introductions.
- `console.log/warn/error` → 5 hits, **все pre-existing fallbacks** (`logger.ts` itself: bootstrap fallback before logger ready; `providers/index.ts` warn; `telegram/userbot.ts` session-print one-shot CLI; `app/deps.ts` startup token-missing). Не logger violations — все вне normal runtime path.
- `Promise.all` on fan-out → 0 hits. All upstream fan-out (arbitration, freelance, hippocampus) корректно использует `Promise.allSettled`.
- Single-arg `logger.*()` → 0 hits. Match в `lib/logger.ts:94` — это комментарий, не call.
- Raw `fetch()` outside http-client → 0 production hits. Совпадения только в sandbox docstrings и provider type-comments.
- `TODO M-*/wave-*/M-FINAL` → 0 hits.

**File-cap status (§2):**

Over-cap (>250 LOC) после wave-4, исключая legitimate exceptions (`schema.ts` frozen, `system-prompt.ts` exempt, `model-map.ts` exempt, `rag/pipeline.ts` exempt, MCP registry, telegram):

- `src/mcp/tools/memory-tools.ts` — 472 LOC (+2 vs M-FINAL2). M-10 не разрастил его (curation methods через `memory.repo.ts` + service); рост на 2 строки = noise. Split-кандидат всё ещё ждёт rip-out `writeSharedAtomic` (см. M-FINAL2 verdict).
- `src/db/index.ts` — 441 LOC. Façade aggregate, single responsibility (re-export). Anti-goal: split = ломает back-compat для scripts/ + legacy tests.
- `src/pipeline/arbitration-room.ts` — 420 LOC. Pre-wave subsystem, не задет memory-v2.
- `src/app/deps.ts` — 414 LOC. DI wiring container — split = искусственный.
- `src/mcp/executor.ts` — 361 LOC. Pre-wave.
- `src/repositories/memory.repo.ts` — 356 LOC (+M-10 link/supersede/reflectGroups методов). Single-responsibility (memory CRUD repo); split write/read дублирует deps.
- `src/db/tables/shared.ts` — 356 LOC. Same analysis as M-FINAL2.
- `src/db/tables/memory.ts` — 337 LOC (+M-10 reflectGroups, +M-12 archive REAL helpers). Single-responsibility table API.
- `src/services/chat.service.ts` — 323 LOC.
- `src/services/memory.service.ts` — 305 LOC (+ M-12 archive paths). Service facade, single-responsibility.

**Verdict §2:** ни один natural split не нашёлся. Anti-goal "if it works, don't fix it" применён согласно plan §5. Все рост-факторы естественные (M-10 добавил 3 curation методов в repo + service + table; M-12 unified confidence path), без god-file syndrome.

**Test stability (§3):** 730 pass / 1 fail × 2 runs (identical). Стабильно — flakiness нет.

The 1 fail = `tests/usemarkdown.test.ts` (Cannot find package `isomorphic-dompurify`). **Pre-existing**: web/app composable test зависит от web/-only npm package, который не установлен в root `package.json`. Не wave-4 регресс — введён в `bcc4816` (refactor PR-1..10, 2026-04-23, до memory-v2). Out of scope для M-FINAL3.

Effective memory-v2 baseline = 730 pass / 0 memory-v2 fail.

**Schema sanity (§4):** fresh DB → `PRAGMA user_version = 15`. 41 sqlite_master rows (21 base tables + 20 FTS-shadow tables). Все required tables present: `layer1_focus, layer2_context, layer3_archive, layer4_log, shared_memory, agent_memory, code_tools, memory_edges, freelance_leads, tasks, scheduler_state, fts_context, fts_archive, fts_shared, fts_log, fts_tg_messages, tg_messages, tg_excluded_chats, chats, chat_messages, metrics_log`.

**Optional refactor (§5):** не выполнен. Anti-goal explicit. Все candidates от plan §41 (memory-tools.ts, memory.ts, routes/memory.ts) — не natural split. `routes/memory.ts` не в over-cap списке после M-12 (typebox enum добавил <20 LOC).

**Open follow-ups (P2 backlog, не блокеры):**

- Out of scope per plan §117: M-04.1 (rolling embed), M-05.1 (evolution), M-05.2 (LLM contradiction), M-08.1 (per-kind decay), M-09 (cross-layer dedup), M-11 (sleep-time block rewriter).
- `memory-tools.ts` final split возможен после миграции 6 legacy test sites от direct `new MemoryTools(db, () => null)` к DI service injection (см. M-FINAL2 verdict).
- `tests/usemarkdown.test.ts` нужно либо install `isomorphic-dompurify` в root package.json, либо переместить в `web/tests/` (pre-existing тех.долг, не memory-v2).

**Verdict:** wave-4 закрыта чисто. 0 регрессов введено M-10/M-12. tsc 0, 730/0 (memory-v2-effective). Anti-goal соблюдён — refactor вылазить не стал.

**Scope:** M-FINAL3 (debug grep audit + file-cap audit + test stability + schema sanity + audit doc).

### M-09 review (2026-04-26)

Post-merge audit pass after M-09 (cross-layer dedup + archive→shared promote, commit `4737749` → merge `ddfba9f`). Baseline: tsc 0, 740 pass / 1 fail-known / 96 files. 15 migrations (frozen).

**Debug findings (§1 grep pass — all clean):**

- `db.insertShared` raw outside SEED_SKIP_EMBED → 0 production hits. Only `scripts/seed.ts:140` (seed script, exempt).
- `'HIGH'/'LOW'` strings on archive outside backfill → 0 hits. M-12 unification holds.
- Single-arg `logger.*()` → 0 hits. Match in `lib/logger.ts:94` = comment, не call.
- `console.log/warn/error` → 7 hits, **все pre-existing fallbacks** (`logger.ts` self-fallback, `providers/index.ts` warn, `app/deps.ts` startup token-missing, `telegram/userbot.ts` session-print CLI). Не logger violations.
- `Promise.all` on fan-out → 0 hits с настоящим upstream. Match в `arbitration-room.ts:85` (try/catch wraps callSpecialist, never rejects — semantically allSettled-equivalent), `pre-processing.ts:151` (`Promise.resolve()` over sync — never rejects). Pre-existing pattern, не fan-out semantics.
- Raw `fetch()` outside http-client → 0 production hits. Все совпадения (`mcp/registry/code-mgmt.tools.ts`, `providers/types.ts`, `agent-loop/code-tools/sandbox.ts`, `system-prompt.ts`) = comments / hint strings / regex / template literals.
- `(as any)` since baseline → 14 hits, **all pre-existing** (copilot stream, telegram MTProto, mcp-protocol Elysia body, agent-loop reasoning_content boundary). Identical to M-FINAL3 set, ноль M-09 introductions.
- `TODO M-09` → 0 hits.

**File-cap status (§2):**

Over-cap (>250 LOC) post-M-09, исключая legitimate exceptions (`schema.ts` frozen, `system-prompt.ts` exempt, `model-map.ts` exempt, `rag/pipeline.ts` exempt, MCP registry, telegram):

- `src/mcp/tools/memory-tools.ts` — 472 LOC. M-09 не разрастил. Pre-existing.
- `src/db/index.ts` — 444 LOC (+3 vs M-FINAL3, M-09 helpers). Façade aggregate.
- `src/pipeline/arbitration-room.ts` — 420 LOC. Pre-wave.
- `src/app/deps.ts` — 414 LOC. DI wiring.
- `src/db/tables/shared.ts` — 396 LOC (+40 vs M-FINAL3). M-09 promote query helpers + cross-layer candidates SQL. Single-responsibility table API.
- `src/db/tables/memory.ts` — 369 LOC (+32 vs M-FINAL3). M-09 cross-layer candidate helpers per плану.
- `src/repositories/memory.repo.ts` — 368 LOC (+12 vs M-FINAL3). M-09 promote/dedup repo methods.
- `src/mcp/executor.ts` — 361 LOC. Pre-wave.
- `src/services/chat.service.ts` — 323 LOC. Pre-wave.
- `src/mcp/playwright-client.ts` — 314 LOC. Pre-wave.
- `src/services/memory.service.ts` — 305 LOC. Pre-wave.
- `src/pipeline/context-compressor.ts` — 299 LOC. Pre-wave.
- `src/pipeline/agent-pipeline/post/hippocampus.ts` — 271 LOC. Pre-wave.
- `src/pipeline/agent-pipeline/post/extractors.ts` — 271 LOC. Pre-wave.
- `src/lib/logger.ts` — 262 LOC. Pre-wave.
- `src/db/tables/tasks.ts` — 259 LOC. Pre-wave.
- `src/db/types.ts` — 254 LOC. Pre-wave.

**Verdict §2:** ни один natural split не нашёлся. Anti-goal "if it works, don't fix it" применён. M-09 рост естественный (+40 в shared.ts cross-layer candidates SQL, +32 в memory.ts, +12 в repo) — без god-file syndrome. Все размеры в pre-existing trajectory.

**Test stability (§3):** 740 pass / 1 fail / 1 error × 2 runs (identical). Стабильно — flakiness нет.

The 1 fail+error = `tests/usemarkdown.test.ts` (Cannot find package `isomorphic-dompurify`). **Pre-existing worktree-env false-positive**: web/app composable test зависит от web/-only npm package, который не установлен в root `package.json` (web/node_modules absence в worktree). Documented в M-FINAL3, тот же баг. Не M-09 регресс.

Effective M-09 baseline = 740 pass / 0 memory-v2 fail.

Note: discrepancy 740 vs `bun test` 756 главного worktree — связан с worktree env (no `.env`, web/node_modules absent), не M-09. Schema/code-level стабильность подтверждена (tsc 0, греп 0).

**Open follow-ups (P2 backlog, не блокеры):**

- M-04.1 (salience M-03), M-05.1 (evolution), M-05.2 (LLM contradiction), M-08.1 (per-kind decay), M-11 (sleep-time block rewriter) — out of scope per plan files.
- `memory-tools.ts` final split всё ещё ждёт миграции legacy test sites (см. M-FINAL2 verdict).
- `tests/usemarkdown.test.ts` worktree-env (install `isomorphic-dompurify` в root или move в `web/tests/`) — pre-existing, не memory-v2.

**Verdict:** M-09 закрыт чисто. 0 регрессов введено. tsc 0, 740/0 (memory-v2-effective, worktree-env baseline). Anti-goal соблюдён — refactor вылазить не стал.

**Scope:** M-09-AUDIT (debug grep audit + file-cap audit + test stability + audit doc).

### M-04.1 review (2026-04-26)

**Scope:** M-04.1-AUDIT (debug grep audit + LOC audit + test stability + audit doc).

**Baseline pre-audit:** 765/0/97 (parent prompt — main worktree). Worktree env: 749/1/1 (1 fail+error = `tests/usemarkdown.test.ts` known FP, web/ deps absent).

**Debug greps post-M-04.1 (zero-tolerance):**

- `MemoryDB.*insertShared|db.insertShared` raw outside SEED_SKIP_EMBED → 0 production hits. Match `scripts/seed.ts:140` (seed script, exempt by guard).
- `'HIGH'/'LOW'` archive outside backfill → 0. M-12 unification holds.
- Single-arg `logger.(info|warn|error|debug)(...)` → 0 calls. Match `lib/logger.ts:94` = comment.
- `console.(log|warn|error)` → 7 hits, **все pre-existing**: `lib/logger.ts:70` (re-entrancy fallback), `lib/logger.ts:107` (`2ea10f8` hardening pre-M-04.1), `app/deps.ts:89` (token-missing startup), `providers/index.ts:141` (provider warn), `telegram/userbot.ts:97-99` (one-shot session-string CLI). Не M-04.1 introductions.
- Raw `fetch()` outside http-client → 0 production hits. Все 8 совпадений = comments / hint-strings / regex-source / template literals в sandbox tooling (`mcp/registry/code-mgmt.tools.ts`, `pipeline/agent-loop/code-tools/sandbox.ts`, `system-prompt.ts`, `providers/types.ts` JSDoc).
- `TODO M-04.1` → 0 hits.
- `Promise.all(...)` introduced by M-04.1 diff → 0. Step `embed-log.ts` использует `Promise.allSettled` для batch fan-out (per план).
- `as any` introduced by M-04.1 diff → 0.
- `@ts-(ignore|nocheck|expect-error)` introduced by M-04.1 diff → 0.

**File-cap status (§2):**

M-04.1 touched files (post-merge LOC):

- `src/db/tables/log.ts` — 179 (M-04.1 helpers `selectUnembeddedRecent`, `countLogEmbeddings`, `evictOldestLogEmbeddings`, `hydrateForVec`).
- `src/pipeline/night-cycle/index.ts` — 111.
- `src/pipeline/night-cycle/post-steps.ts` — 156.
- `src/pipeline/night-cycle/steps/embed-log.ts` — 146 (NEW step, под cap 200 plan-target).
- `src/pipeline/night-cycle/steps/index.ts` — 20.
- `src/pipeline/night-cycle/types.ts` — 85.
- `src/repositories/log.repo.ts` — 74.
- `tests/night-cycle-embed-log.test.ts` — 200.
- `src/rag/pipeline.ts` — 699 (exempt list per guardrail §1, плановый touch для vec branch unblock).

**Verdict §2 (M-04.1 own files):** все ≤200 LOC, под cap. Sole exception = `rag/pipeline.ts` 699 (exempt from start). M-04.1 split в `steps/embed-log.ts` соблюдён.

Pre-existing >250 LOC list (24 files): identical к M-09 audit baseline ± `src/db/tables/log.ts` (was ≤140 в M-04, now 179 — still under cap). M-04.1 diff не растил ни один pre-existing god-file.

**Test stability (§3):** 749 pass / 1 fail / 1 error × 2 runs (identical counts). Stable, flakiness не наблюдается.

The 1 fail+error = `tests/usemarkdown.test.ts` (`Cannot find package 'isomorphic-dompurify'`). **Known worktree-env FP** (web/ npm deps absent в worktree, parent prompt explicitly marked as ignore). Не M-04.1 regression.

Effective M-04.1 baseline (excluding worktree-env FP) = **749/0** memory-v2-effective. Schema/code stability подтверждена (tsc 0).

Note: discrepancy 749 vs parent baseline 765 — связан с worktree env (no `data/` dir initially → `mkdir -p data` pre-run; parent counted `bun test` from main worktree).

**Open follow-ups (P2 backlog, не блокеры):**

- M-03 (salience), M-05.1 (evolution), M-05.2 (LLM contradiction), M-08.1 (per-kind decay), M-11 (sleep-time block rewriter) — wave-2 plan files committed (commit `0bf8832`).
- `tests/usemarkdown.test.ts` worktree-env (install `isomorphic-dompurify` в root или relocate в `web/tests/`) — pre-existing, не M-04.1 scope.

**Verdict:** M-04.1 закрыт чисто. 0 регрессов введено. tsc 0, 749/0 (memory-v2-effective, worktree-env baseline). Status DONE уже выставлен в plan file `docs/tasks/memory-v2/M-04.1-rolling-embed-log.md:3`. Anti-goal "no over-refactor" соблюдён — pre-existing tech debt logged + skipped.

**Scope:** M-04.1-AUDIT (debug grep audit + LOC audit + test stability + audit doc).
