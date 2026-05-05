# 28-W3-10 — split `services/chat.service.ts` (323 → split-folder) — **HOT PATH**

**Status:** OPEN. Master: [28-file-size-150-limit.md](28-file-size-150-limit.md) Wave 3.

**Order:** parallel. **HOT PATH** — обязательный full-test + integration.live + локальный smoke.

## Цель

Разбить `packages/agent/src/services/chat.service.ts` (323 LOC) на split-folder. Public API = `ChatService` class + standalone helpers (`sanitizeAgentId`, `extractChatMeta`, `wrapStreamForChat`).

## Файлы

**Удалить**:
- `packages/agent/src/services/chat.service.ts`

**Создать**:
- `packages/agent/packages/agent/packages/agent/src/services/chat/index.ts` — `ChatService` orchestrator class (≤120 LOC). Хранит deps + thin делегации. **Re-exports**: `sanitizeAgentId`, `extractChatMeta`, `wrapStreamForChat` (consumers ожидают их по тому же import path).
- `packages/agent/src/services/chat/rag-context.ts` — `loadRagContext`, `buildSystemPrompt` — RAG hippocampus + system prompt assembly.
- `packages/agent/src/services/chat/model-select.ts` — `resolveModel`, `applyOpenAICompatOverrides`, `selectVirtualRole` — virtual role resolution.
- `packages/agent/src/services/chat/sse-format.ts` — `wrapStreamForChat`, SSE chunk parsing → DB persist (`chats` table). 
- `packages/agent/src/services/chat/helpers.ts` — `sanitizeAgentId`, `extractChatMeta`. Pure functions.

**Trigger**: `scripts/check-file-size.ts` `"packages/agent/src/services/chat.service.ts": 324` → удалить.

## Изменение

1. `ChatService` class в `index.ts` — конструктор + thin делегации.
2. Submodules — pure functions taking deps explicitly.
3. **Re-exports critical**: `sanitizeAgentId`, `extractChatMeta`, `wrapStreamForChat` — экспортированы из `index.ts` для backward-compat (consumers `routes/chat.ts`, `routes/agent.ts`, `tests/cross-agent-isolation.test.ts`, etc).
4. Никаких изменений семантики.
5. Consumers — через `~/services/chat` (auto-resolve через index.ts).

## Тесты

- `bun test tests/chat*.test.ts` — green.
- `bun test tests/cross-agent-isolation.test.ts` — green.
- `bun run tests/integration.live.ts` (если запущен сервер) — green.
- `bun test` — без regression (838/0).

## Приёмка

**HOT PATH — особое внимание**:

1. `bun run scripts/check-file-size.ts` — split ≤150, transitional удалена.
2. `bun run scripts/check-deep-imports.ts` — green.
3. `bunx tsc --noEmit` — clean.
4. `bun test tests/repo-rules.test.ts` — 5/5.
5. `bun test` — 838/0 baseline.
6. `grep -rn 'from "[^"]*chat\\.service"' src/ tests/` → пусто (переключаются на `chat`).
7. `grep -rn 'sanitizeAgentId\|extractChatMeta\|wrapStreamForChat' src/ tests/` — все consumers резолвят через `~/services/chat` без deep-import'ов.

## Constraints

- Scope-lock: только файлы в §Файлы.
- Public API: `ChatService` class + 3 helpers (`sanitizeAgentId`, `extractChatMeta`, `wrapStreamForChat`) unchanged.
- HOT PATH: интеграционные тесты + локальный smoke required перед merge.
- SSE heartbeat (5s ping) preserved.
- `wrapStreamForChat` honors `isClosed` — никаких DB writes после cancel.
