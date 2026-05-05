# 28-W3-8 — split `telegram/bot.ts` (343 → split-folder)

**Status:** OPEN. Master: [28-file-size-150-limit.md](28-file-size-150-limit.md) Wave 3.

**Order:** parallel.

## Цель

Разбить `packages/agent/src/telegram/bot/index.ts` (343 LOC) на split-folder. Public API = `TelegramBot` class. **`notify(chatId, msg)` — public logic-API** (см. SoC §3 cross-layer rule); используется scheduler/pipeline для уведомлений.

## Файлы

**Удалить**:
- `packages/agent/src/telegram/bot/index.ts`

**Создать**:
- `packages/agent/src/telegram/bot/index.ts` — `TelegramBot` class (≤120 LOC). Конструктор + thin делегации.
- `packages/agent/src/telegram/bot/commands.ts` — command handlers (/start, /help, /status, etc — список из текущего bot.ts).
- `packages/agent/src/telegram/bot/routing.ts` — message dispatch (text → AgentLoop, command → command-handler).
- `packages/agent/src/telegram/bot/notify.ts` — **public** `notify(chatId, msg, options?)` — вызывается из scheduler/pipeline для уведомлений. Это logic-helper, НЕ transport.

**Trigger**: `scripts/check-file-size.ts` `"packages/agent/src/telegram/bot/index.ts": 344` → удалить.

## Изменение

1. `TelegramBot` class в `index.ts` — конструктор `(token, dispatcher, ...)` + thin делегации.
2. Submodules — pure functions taking `{bot, deps}` explicitly.
3. `notify(chatId, msg)` экспортируется из `notify.ts` И как метод класса для backward compat.
4. Все consumers (`scheduler/free-agent.ts`, `scheduler/freelance/persist.ts`, `pipeline/agent-pipeline/post/notify`) — через `~/telegram/bot` (или `~/telegram` barrel если есть).

## Тесты

- `bun test tests/telegram*.test.ts` — green.
- `bun test` — без regression (838/0).

## Приёмка

1. `bun run scripts/check-file-size.ts` — split ≤150, transitional удалена.
2. `bun run scripts/check-deep-imports.ts` — green.
3. `bunx tsc --noEmit` — clean.
4. `bun test tests/repo-rules.test.ts` — 5/5.
5. `bun test` — 838/0 baseline.

## Constraints

- Scope-lock: только файлы в §Файлы.
- Public API: `TelegramBot` + `notify(chatId, msg)` unchanged.
- `notify()` остаётся вызываемым из scheduler/pipeline (logic-API, НЕ transport).
- Не трогать `userbot.ts` (это W3-9).
