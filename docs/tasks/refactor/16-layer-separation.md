# Глава 16 — Security, correctness, layer separation

**Scope:** серия PR 17–27. Не продолжение рефакторинга 01–15 (тот закрыт — все HIGH/CRIT из `docs/02-audit.md` выполнены), а новая ось: фолаут аудита безопасности/корректности + поэтапное введение слоёв (controller / service / repository).

**Status:** PLANNED

## Зачем глава существует

Мини-аудит (подтверждён чтением кода) выявил:

1. **Auth дырявый.** `/api/token`, `/night-cycle`, `/night-cycle/status` объявлены ДО `authMiddleware` в [packages/server/packages/server/src/app/bootstrap.ts:93-103](../../../packages/server/packages/server/src/app/bootstrap.ts#L93-L103). Утекает token в ответ. Плюс [packages/core/src/lib/auth.ts:28](../../../packages/core/src/lib/auth.ts#L28) глобально пропускает `/telegram/*` — админ-ручки `set-webhook`/`remove-webhook` без защиты.
2. **`tg_send_message` лжёт.** [packages/agent/packages/agent/src/telegram/bot/index.ts:238](../../../packages/agent/packages/agent/src/telegram/bot/index.ts#L238) `notify()` глотает err; [packages/agent/packages/agent/src/mcp/executor/index.ts:76](../../../packages/agent/packages/agent/src/mcp/executor/index.ts#L76) `tgSendMessage()` не видит падения и всегда возвращает `success:true`. Агент думает «уведомил».
3. **Layer 4 почти пустой.** [packages/core/packages/core/src/db/schema.ts:305](../../../packages/core/packages/core/src/db/schema.ts#L305) CHECK `role IN (user/assistant/system/tool/reasoning)`; [packages/core/src/lib/logger.ts:75](../../../packages/core/src/lib/logger.ts#L75) пишет `_log_${level}` → CHECK violation. [packages/core/src/lib/logger.ts:78](../../../packages/core/src/lib/logger.ts#L78) проглатывает exception. Observability иллюзорна. Плюс [packages/agent/packages/agent/src/telegram/userbot/index.ts:319](../../../packages/agent/packages/agent/src/telegram/userbot/index.ts#L319) пишет role=`channel_message` — та же история.
4. **Sandbox — не security boundary** (сам [packages/agent/packages/agent/packages/agent/src/pipeline/agent-loop/code-tools/sandbox.ts:10](../../../packages/agent/packages/agent/packages/agent/src/pipeline/agent-loop/code-tools/sandbox.ts#L10) признаёт). Но [packages/agent/packages/agent/packages/agent/src/pipeline/agent-loop/system-prompt.ts:167](../../../packages/agent/packages/agent/packages/agent/src/pipeline/agent-loop/system-prompt.ts#L167) поощряет scheduled-агентов создавать code tools без approval.
5. **Memory writes без confidence.** Post-hippocampus пишет в shared/context мгновенно; нет разделения «высокоуверенный факт» vs «предположение».
6. **Cancellation половинчатая.** [packages/agent/packages/agent/packages/agent/src/pipeline/agent-loop/tool-runner.ts:45](../../../packages/agent/packages/agent/packages/agent/src/pipeline/agent-loop/tool-runner.ts#L45) + [packages/agent/packages/agent/src/pipeline/arbitration/index.ts:85](../../../packages/agent/packages/agent/src/pipeline/arbitration/index.ts#L85) делают `Promise.race` без `controller.abort()` — underlying fetch/browser work продолжается в фоне.
7. **Provider startup над-требовательный.** Все virtual roles в [packages/core/src/lib/model-map.ts:21](../../../packages/core/src/lib/model-map.ts#L21) primary=MiniMax, но [packages/providers/packages/server/src/index.ts:23](../../../packages/providers/packages/server/src/index.ts#L23) всё равно требует Copilot+OpenRouter. `directMode` в [packages/server/packages/server/src/routes/chat.ts:31](../../../packages/server/packages/server/src/routes/chat.ts#L31) срабатывает по NVIDIA overload даже если модель MiniMax → внезапно обходит pipeline + память.
8. **Shared RAG slaby.** [packages/agent/packages/agent/src/rag/pipeline/index.ts:156](../../../packages/agent/packages/agent/src/rag/pipeline/index.ts#L156) vec-путь не подтягивает shared row — snippet пустой. [packages/agent/packages/agent/packages/agent/src/pipeline/agent-pipeline/post/extractors.ts:29](../../../packages/agent/packages/agent/packages/agent/src/pipeline/agent-pipeline/post/extractors.ts#L29) `writeShared` не эмбеддит → semantic-поиск по shared не работает.
9. **Нет слоёв.** Routes делают DB-доступ + бизнес-логику + HTTP-shaping в одном файле.

## Цель главы

Закрыть пункты 1–8 точечными PR; ввести слои (пункт 9) поэтапно без мегамерджа.

## Locked design decisions

- **D1 — memory status enum = 3-state** (`pending | active | rejected`). Так пользователь может явно отвергать, а не просто игнорировать.
- **D2 — memory approve UI-only.** TG-approval — отдельная follow-up задача вне главы.
- **D3 — `isOverloaded` становится `isOverloadedFor(provider)`** — per-provider, не NVIDIA-only.
- **D4 — `channel_message` = тип сообщения, не role.** Правильный фикс (msg_type column или role=tool + content prefix) — architectural debt, tracked отдельной задачей. PR 19 ставит migration + останавливает silent swallow; архитектурный долг — вне главы.
- **D5 — `codeToolsReadOnly` в scheduled mode.** Существующие `code_*` тулы выполняются; `create_tool` / `create_code_tool` / `edit_code_tool` скрыты.
- **D6 — `MEMORY_AUTOACCEPT_CONFIDENCE` env, default `0.8`.**
- **D7 — Deploy 100% manual.** GitHub заблокирован, `gh` / `git push` мертвы. Единственный путь — SSH + `git pull` / `rsync` + `docker compose build && up -d`. Ни один PR не полагается на CI-hooks.

## PR-таблица

| # | Файл | Тема | Размер | Зависимости |
|---|---|---|---|---|
| 17 | [17-auth-hardening.md](17-auth-hardening.md) | Закрыть auth на `/api/token`, `/night-cycle*`, `/telegram/set-webhook`, `/telegram/remove-webhook`; сузить `/telegram/*` bypass до `/telegram/webhook` | ~80 | — |
| 18 | [18-tg-honest-errors.md](18-tg-honest-errors.md) | `notifyOrThrow()` + честный `tgSendMessage` + ToolError propagation | ~80 | — |
| 19 | [19-log-roles-migration.md](19-log-roles-migration.md) | Migration 6 + fix logger swallow | ~90 | — |
| 20 | [20-abort-propagation.md](20-abort-propagation.md) | AbortSignal в tool-runner + arbitration (split на 20a/20b если >250) | ~180 | — |
| 21 | [21-scheduled-mode-guard.md](21-scheduled-mode-guard.md) | Scheduled mode скрывает `create_tool`/`create_code_tool`/`edit_code_tool` | ~120 | — |
| 22a | [22a-memory-confidence-schema.md](22a-memory-confidence-schema.md) | Migration 7 + confidence/status в writers + RAG injection filter | ~180 | 19 |
| 22b | [22b-memory-approval-ui.md](22b-memory-approval-ui.md) | /v1/memory/pending + Vue tab + approve/reject | ~120 | 22a |
| 23 | [23-directmode-and-provider-startup.md](23-directmode-and-provider-startup.md) | `isOverloadedFor(provider)` + optional Copilot/OpenRouter startup | ~150 | — |
| 24 | [24-shared-rag-fix.md](24-shared-rag-fix.md) | `writeShared` embed + `getSharedMany` в vec-путь | ~80 | — |
| 25a | [25a-service-auth.md](25a-service-auth.md) | `AuthService` — первый срез «bootstrap→service» | ~120 | 17 |
| 25b | [25b-service-memory.md](25b-service-memory.md) | `MemoryService` — второй срез | ~150 | 17, 22a |
| 26a | [26a-service-chat.md](26a-service-chat.md) | `ChatService` | ~180 | 25a |
| 26b | [26b-service-agent.md](26b-service-agent.md) | `AgentService` — orchestrates scheduled/interactive | ~200 | 21, 26a |
| 27 | [27-repository-db.md](27-repository-db.md) | Repository-слой над `db/tables/*` | ~200 | 10 (done), 25b, 26a, 26b |

## Граф зависимостей

```
17 ─► 25a ─► 26a ─► 26b
19 ─► 22a ─► 22b
21 ─► 26b
10(done) ─► 27
25b ─► 27
26a ─► 27
17, 18, 20, 23, 24 — независимы
```

## Приоритет исполнения

```
День 1 (security P0):         PR 17, 18, 19
День 2 (correctness P0):      PR 20, 21
День 3 (memory schema):       PR 22a
День 4 (memory UI):           PR 22b
День 5 (provider correctness):PR 23, 24
День 6 (auth as service):     PR 25a
День 7 (memory as service):   PR 25b
День 8 (chat as service):     PR 26a
День 9 (agent as service):    PR 26b
День 10 (repository DAL):     PR 27
```

~10 дней в одну руку. 17+18+20+23+24 параллелизуются.

## Открытые вопросы (ответить перед началом главы)

- (Q1) Согласны с 3-state enum для memory status (D1)? Если достаточно 2-state (`pending`/`active`), PR 22a упрощается — UI тоже.
- (Q2) Ок что TG-approval остаётся вне главы (D2)?
- (Q3) Размер/сроки — устраивает разбивка 10 дней? Если нет, какие PR отложить?
- (Q4) PR 23b: оставляем NVIDIA обязательным пока RAG/rerank используется. Если хочется «RAG-off режим» — это +1 PR.

## Критерии закрытия главы

- Все PR 17–27 мёрджены, статус DONE в каждом файле.
- В `docs/02-audit.md` закрыты: AUTH-16, TG-1, OBS-1, CANCEL-1, SCHED-1, MEM-5, ROUTE-1, RAG-1, LAYER-1..LAYER-4.
- `OBS-2` (channel_message как msg_type) **остаётся открытым как follow-up** — не блокирует закрытие главы, tracked в audit.md как architectural debt (см. PR 19).
- `CLAUDE.md` «Active refactor» секция обновлена: «Chapter 2 complete».
- В [refactor/README.md](README.md) строки 17–27 вычеркнуты, статус DONE.

## Шаг 0 — завести open items в audit.md

**Перед стартом PR 17** добавить в [docs/02-audit.md](../../02-audit.md) addendum 2026-04-24 с новыми open items:
`AUTH-16`, `TG-1`, `OBS-1`, `OBS-2` (follow-up), `CANCEL-1`, `SCHED-1`, `MEM-5`, `ROUTE-1`, `RAG-1`, `LAYER-1..LAYER-4`. Каждый — с file:line reference и одной строкой fix-описания. Addendum уже записан в audit.md в рамках планирования главы; исполнитель первого PR проверяет актуальность и вычёркивает по мере закрытия.

## Правила закрытия каждого PR

1. `Status: DONE (PR #N)` в шапке файла `NN-*.md`.
2. Соответствующий `AUTH-*`/`TG-*`/etc. вычеркнут в [docs/02-audit.md](../../02-audit.md).
3. Если менялась структура — синхронизировать `CLAUDE.md`.
4. Никогда не использовать `docker compose down -v` на VPS.

## Deploy procedure (повторяется в каждом PR)

```bash
ssh root@109.120.187.244
cd /opt/subbrain
git pull   # или rsync с рабочей машины, если git auth сломан
docker compose build && docker compose up -d
docker compose logs -f
```

GitHub заблокирован — `gh pr create`, push-to-deploy, PR-triggered CI пути не работают. Любой PR-файл, упоминающий эти пути, некорректен.
