# 28-W1-1 — split `useChatStream.ts` (152 → ≤150)

**Status:** OPEN. Master: [28-file-size-150-limit.md](28-file-size-150-limit.md) Wave 1.

## Цель

Разбить `web/app/composables/useChatStream.ts` (152 LOC, нарушение FILE-SIZE-1) на split-folder с чёткой ответственностью per-файл. Public API композабла не меняется — `useChatStream() → { readSSEStream, readAgentSSE }`.

## Файлы

**Удалить** (после переноса):
- `web/app/composables/useChatStream.ts`

**Создать**:
- `web/app/composables/useChatStream/index.ts` — composable orchestrator (≤60 LOC), reexport public API.
- `web/app/composables/useChatStream/readChatSSE.ts` — `readSSEStream` parser (chat-completion SSE формат `data: {choices:[{delta:...}]}`).
- `web/app/composables/useChatStream/readAgentSSE.ts` — `readAgentSSE` parser (named-event SSE: step/tool_call/tool_result/response/done/error/thinking).

**Trigger transitional whitelist removal**: `scripts/check-file-size.ts` строка `"web/app/composables/useChatStream.ts": 152` → удалить (entry больше не существует).

## Изменение

1. Старый файл содержит замыкание `useChatStream()`, дёргающее `useChatState()` для `updateLastAssistant` + `flushStreamingPaint`. Эти зависимости передаются в split-функции через параметр (DI), либо парсеры сами вызывают `useChatState()` (composable rule).
2. Минимальная связь: index.ts собирает зависимости и проксирует в parser-модули. Parser-модули принимают `(reader, deps)` либо `(res, deps)`.
3. Никаких изменений семантики SSE-парсинга — побайтная копия логики (only refactor-shape, no logic changes).
4. Vue/TS импорты в новых файлах — относительные, через `import` из соседних `*.ts` (Nuxt auto-import для composables работает только из `composables/<name>.ts`; index.ts остаётся auto-importable как `useChatStream`).

## Тесты

Нет существующих unit-тестов для этого composable (UI-only, проверяется через manual smoke в чате). Добавление тестов в скоупе W1-1 — OUT OF SCOPE.

Manual smoke (NOT requirement, но желательно zaprotonkat'):
- `bun run dev` (или `web/app && bun run dev`).
- Открыть `/`, отправить prompt в чат → стрим в DevTools → проверить, что `readSSEStream` рендерит content + reasoning.
- Открыть `/agent` (autonomous), послать запрос → проверить, что step/tool_call/tool_result frames appear inline.

## Приёмка

Все команды из repo root, exit 0:

1. `bun run scripts/check-file-size.ts` — все split-файлы ≤150, transitional entry удалена.
2. `bun run scripts/check-deep-imports.ts` — без новых нарушений.
3. `bunx tsc --noEmit` — без regressions.
4. `bun test tests/repo-rules.test.ts` — все 5 tests зелёные.
5. `bun test` — без новых failed (baseline неизменен).
6. Поиск `useChatStream` через `grep -rn 'useChatStream' web/app/`: импортируется как функция через Nuxt auto-import (без явных import statements, либо через `~/composables/useChatStream`). Не должно быть deep-import'ов в split-internals.

## Constraints

- **Scope-lock**: трогать только файлы в §Файлы выше. Не редактировать `useChatState.ts`, не вводить новых composable'ов, не переписывать логику SSE.
- Vue SFC unaffected.
- Auto-import compatibility: после split, `useChatStream()` должен оставаться вызываемым из `pages/index.vue` без изменений.
