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

### MEM-9 ✅ memory kind/persona enum (закрыто M-07)
`shared_memory` смешивал personality-факты (profile/preference/relationship) с semantic-знанием (goal/skill/constraint/style) в одной плоской таблице. Не было способа отличить "пользователь любит Hyprland" (persona, ↑ приоритет в системном промпте) от "TypeScript строгая типизация важнее DX" (semantic, средний приоритет).
**Fix:** M-07 — миграция 12 (M-04 takes 11, no conflict): `kind TEXT NOT NULL DEFAULT 'semantic'` на `shared_memory` + UPDATE backfill из category (profile/preference/relationship → persona, остальное → semantic) + 2 BEFORE-триггера (INSERT + UPDATE OF kind) для CHECK enum (SQLite ALTER не поддерживает ADD CHECK) + idx_shared_kind. `categoryToKind(category, layer)` pure-fn в `post/validators.ts` (re-export `MemoryKind` из `db/types.ts`); `extractors.writeShared` + merge-update derive kind через helper. `RAGPipeline.applyPersonaBoost` post-rerank: `score *= 1.1` для `kind === 'persona'` shared rows + re-sort. `RAGResult.kind?: string` — optional т.к. context/archive/log не имеют поля. Admin `GET /v1/memory/shared?kind=persona` через TypeBox `t.Union([t.Literal(...)])` enum (rejects garbage 422). UI: `kindFilter` state в `useMemory` + dropdown only on shared tab.
Tests: `tests/memory-kind.test.ts` (18 кейсов — schema, idempotency, mapping, CHECK trigger INSERT+UPDATE, service insert, extractors derive, RAG persona boost ranking, admin filter +422 invalid). 668 pass / 0 fail.
**Foundation для M-08** (asymmetric forgetting curve — persona never decays) **и M-11** (sleep-time block rewriter переписывает persona в layer1_focus).
**Scope:** M-07.
