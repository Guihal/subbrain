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

### MEM-2 🟡 `src/rag/pipeline.ts:112` — поиск по слою `shared` без индекса
RAG ищет в трёх слоях, включая `shared`. Но `grep "upsertEmbedding.*shared" src/` → 0 hits. Никто не индексирует `shared_memory` в `vec_embeddings`. Vec-ветка для `shared` всегда пуста; работает только FTS-ветка.
**Fix (варианты):**
- (a) Удалить `shared` из default `layers` массива в RAG — корректнее отражает реальность.
- (b) Или добавить вызов `rag.indexEntry(id, "shared", content)` в каждую запись `shared` (hippocampus `writeShared`, context-compressor `insertShared`, seed-script) — поднимет качество RAG, но увеличит latency post-processing.
**Scope:** design-решение, обсудить отдельно.

### MEM-3 🟡 `src/db/tables/memory.ts:151` — `searchContext` не фильтрует по `agent_id`
`layer2_context` имеет колонку `agent_id` (nullable), но `searchContext(query, limit)` никогда её не учитывает. Публичный и agent-приватный контексты смешиваются при поиске. `pruneContext` уведомляет LLM через prompt, но это soft guard — при ошибке LLM возможен cross-agent merge.
**Fix:** опциональный параметр `agentId?: string` в `searchContext`/`searchShared`, SQL `AND (agent_id = ? OR agent_id IS NULL)`. Также проверить `rag/pipeline.ts` search-ветку контекста.
**Scope:** security/isolation; закрыть вместе с agent-rights аудитом.

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

### OBS-1 🟡 `src/db/schema.ts:305` + `src/lib/logger.ts:75,78` — Layer 4 silent drop
CHECK разрешает `user/assistant/system/tool/reasoning`, logger пишет `_log_${level}` → CHECK violation, `catch {}` глотает. Ни одна запись logger-а не доходит. Observability иллюзорна. Плюс `userbot.ts:319` пишет `channel_message` — та же история.
**Fix:** PR 19 — migration 6 расширить CHECK; в logger catch вывести `console.error` один раз per unique role.
**Scope:** PR 19.

### OBS-2 🟢 архитектурный долг — `channel_message` это тип, не role
`userbot.ts:319` пишет message type в колонку `role`. PR 19 — костыльный фикс (расширение CHECK), правильный фикс: колонка `msg_type` либо `role='tool'` + content prefix. Пост-PR-19 follow-up. Не блокирует главу 16.
**Fix:** отдельная задача после главы 2.

### CANCEL-1 ✅ `src/pipeline/agent-loop/tool-runner.ts:45` + `src/pipeline/arbitration-room.ts:85,225` — timeout без abort (закрыто PR 20)
`Promise.race([exec, timeout])` без `controller.abort()` → underlying fetch/browser/stream продолжает работать до естественного конца, слив RPM и ресурсов на работу с выброшенным результатом.
**Fix:** PR 20 — `withToolTimeout` завёл внутренний `AbortController` и композирует `AbortSignal.any([external, internal])` в effective signal для handler-а; `ToolHandler` получил optional `signal` (back-compat — short handlers игнорируют); long-running handlers (web_* через proxy, consult_chaos, consult_specialists через `ArbitrationRoom.run(..., signal)`) форвардят в downstream; `arbitration-room.callSpecialist` теперь принимает полный `AbortController`, таймер перед `reject` вызывает `controller.abort()`, `synthesize()` тоже получает external signal. Tests: `tests/tool-timeout-abort.test.ts` (3 кейса: timeout abort в 700ms, external abort composition, fast-path), `tests/arbitration-abort.test.ts` (per-specialist timeout + external signal). *(закрыто PR 20).*

### SCHED-1 🔴 `src/pipeline/agent-loop/system-prompt.ts:167` + `src/scheduler/*` — scheduled-агент без approval может писать код
Промпт поощряет `create_code_tool`. Sandbox сам признаёт (`sandbox.ts:10`): не security boundary. Scheduled entrypoints (autonomous, free-agent, возможно night-cycle) стартуют без человека в цикле.
**Fix:** PR 21 — `agentMode: "scheduled" | "interactive"`, scheduled скрывает `create_tool`/`create_code_tool`/`edit_code_tool`; existing code_* остаются; env opt-in.
**Scope:** PR 21.

### MEM-5 🟡 `src/pipeline/agent-pipeline/post/extractors.ts` — memory write без confidence
Post-hippocampus пишет в `shared_memory` / `memory` мгновенно, без оценки уверенности. Модельные догадки попадают в «глобальные факты» и потом цитируются как истина.
**Fix:** PR 22a + 22b — миграция 7 добавляет `confidence REAL` + `status TEXT CHECK('pending'|'active'|'rejected')`; post-hippocampus эмитит confidence; ≥0.8 → active, <0.8 → pending; RAG injection фильтрует только active; UI approve/reject.
**Scope:** PR 22a (schema), 22b (UI).

### ✅ ROUTE-1 `src/routes/chat.ts:31` + `src/lib/model-router.ts:61` — directMode триггерится не тем провайдером (PR #23)
~~`router.isOverloaded` смотрит только на NVIDIA limiter, но все роли primary=MiniMax. Когда NVIDIA перегружена (RAG/embed), чат через MiniMax внезапно переключается в direct mode → обходит pipeline + память. Плюс `providers/index.ts:23` требует Copilot+OpenRouter даже если они не primary/fallback нигде.~~
**Fix:** PR 23 — `isOverloadedFor(provider)` с NVIDIA-alias `isOverloaded @deprecated`; `routes/chat.ts` компьютит directMode через `resolveModel(requested).provider`; `providers/index.ts:createProviders` читает MODEL_MAP и грузит только референснутые провайдеры (NVIDIA всегда, Copilot/OpenRouter — только если в map), unreferenced slots получают stub который кидает на вызове.
**Scope:** PR 23.

### RAG-1 🟡 `src/pipeline/agent-pipeline/post/extractors.ts:29` + `src/rag/pipeline.ts:156` — shared RAG semantic broken
`writeShared` не эмбеддит → vec-поиск не находит. Плюс `rag/pipeline.ts:156` vec-путь для shared не подтягивает row → snippet пустой даже если вектор нашёлся.
**Fix:** PR 24 — `writeShared` async, embed + index (паттерн `writeContext`); `getSharedMany` + hydration в vec-path.
**Scope:** PR 24.

### LAYER-1..LAYER-4 🟢 смешение ответственности в routes
Routes делают DB-доступ + бизнес-логику + HTTP-shaping одновременно. Introduce controller/service/repository слои поэтапно.
**Fix:** ~~LAYER-1 (PR 25a — AuthService)~~ ✅, ~~LAYER-2 (PR 25b — MemoryService)~~ ✅, ~~LAYER-3 (PR 26a — ChatService)~~ ✅, ~~LAYER-4 (PR 26b — AgentService)~~ ✅, затем PR 27 — Repository слой над `db/tables/*`.
**Scope:** PR 25a ✅, 25b ✅, 26a ✅, 26b ✅, 27.
