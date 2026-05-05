# 28-W3-9 — split `telegram/userbot.ts` (348 → split-folder)

**Status:** OPEN. Master: [28-file-size-150-limit.md](28-file-size-150-limit.md) Wave 3.

**Order:** parallel.

## Цель

Разбить `packages/agent/packages/agent/src/telegram/userbot/index.ts` (348 LOC) на split-folder. Public API = `Userbot` class.

## Файлы

**Удалить**:
- `packages/agent/packages/agent/src/telegram/userbot/index.ts`

**Создать**:
- `packages/agent/packages/agent/packages/agent/src/telegram/userbot/index.ts` — `Userbot` class (≤120 LOC). Сессия + ConvCache + thin делегации.
- `packages/agent/src/telegram/userbot/cache.ts` — ConvCache (in-memory cache для conversations + messages).
- `packages/agent/packages/agent/packages/agent/src/telegram/userbot/search.ts` — `searchMessages`, `findConversation` — FTS-подобные операции по cached сообщениям.
- `packages/agent/src/telegram/userbot/parse.ts` — message parsing helpers (extract sender, links, attachments).

**Trigger**: `scripts/check-file-size.ts` `"packages/agent/packages/agent/src/telegram/userbot/index.ts": 349` → удалить.

## Изменение

1. `Userbot` class в `index.ts` — MTProto session + cache instance + thin делегации.
2. Submodules — pure functions taking `{cache, session}` deps.
3. Никаких изменений семантики.
4. Consumers (`mcp/tools/telegram-tools.ts`, scripts, free-agent) — через `~/telegram/userbot`.

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
- Public API: `Userbot` class methods unchanged.
- MTProto session loading via `tg-login.ts` script — preserved.
- Не трогать `bot.ts` (это W3-8) или `mcp/tools/telegram-tools.ts`.
