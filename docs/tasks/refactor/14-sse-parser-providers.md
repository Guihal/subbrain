# Задача 14 — SSE parser unification в providers

**Оценка:** 0.5 дня
**Зависимости:** —
**Status:** DONE

## Цель

[src/providers/copilot.ts](../../../src/providers/copilot.ts) и [src/providers/nvidia.ts](../../../src/providers/nvidia.ts) каждый держит свою копию парсинга SSE-чанков и сборки финального message. Вынести в `providers/sse-parser.ts`, оставив в каждом провайдере только маппинг запрос/ответ.

## API

```ts
// src/providers/sse-parser.ts
export interface ProviderDelta {
  content?: string;
  reasoning_content?: string;        // PR 05 MED-6
  tool_calls?: Array<{
    index: number;                   // OpenAI flavor — accumulates by index
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
  finish_reason?: "stop" | "tool_calls" | "length" | null;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

/** Parse one SSE line into structured delta. Returns null for ping/empty. */
export function parseSSEChunk(line: string): ProviderDelta | null;

/** Merge accumulated deltas into a final assistant Message. */
export function assembleMessage(deltas: ProviderDelta[]): {
  role: "assistant";
  content: string | null;
  reasoning_content?: string;
  tool_calls?: ToolCall[];
  finish_reason: string | null;
  usage?: { prompt_tokens: number; completion_tokens: number };
};
```

## Текущее состояние

- `copilot.ts`: внутри `streamChatCompletion` — собственный reader + JSON.parse каждой `data:` строки + аккумулятор `tool_calls[i].function.arguments += delta.arguments`.
- `nvidia.ts`: то же самое, но без `tool_calls` (NVIDIA для chat не используется, только embed/rerank). Если у `nvidia.ts` нет SSE → не трогать; парсер только для copilot.
- ⚠️ перед тем как двигать — грепнуть `parseSSE`, `data:`, `JSON.parse(line.slice(6))` по `src/providers/`. Возможно общий код — только в copilot, тогда задача упрощается до «вынести из copilot в общий модуль».

## Тесты

`tests/sse-parser.test.ts`:
- `parseSSEChunk("data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}")` → `{content: "hi"}`.
- `parseSSEChunk("data: [DONE]")` → null или специальный sentinel.
- `parseSSEChunk(": ping")` → null (heartbeat).
- `parseSSEChunk("")` → null.
- `parseSSEChunk("data: invalid json")` → throw или null + log warn — выбрать поведение и закрепить тестом.
- Tool calls accumulator: 3 deltas с `function.arguments` = `'{"a":'`, `'1'`, `'}'` → assembled `arguments` = `'{"a":1}'`.
- `assembleMessage` с пустым `content` и `tool_calls` → `content: null` (важно для OpenAI tool-calling совместимости).
- `reasoning_content` (PR 05 MED-6) собирается отдельно, не сливается в `content`.

## Файлы

- `src/providers/sse-parser.ts` (новый)
- [src/providers/copilot.ts](../../../src/providers/copilot.ts) — заменить inline на импорт.
- [src/providers/nvidia.ts](../../../src/providers/nvidia.ts) — если есть SSE-код → тоже.
- `tests/sse-parser.test.ts` (новый)

## Порядок исполнения

1. Грепнуть `data: ` / `[DONE]` / accumulators по `src/providers/` — определить какие файлы реально дублируют логику.
2. Реализовать `sse-parser.ts` + тесты.
3. Перевести `copilot.ts` на парсер. Прогнать `tests/copilot.test.ts` если есть, и `tests/integration.live.ts`.
4. То же для `nvidia.ts` (если применимо).

## Приёмка

- [x] `bunx tsc --noEmit` = 0.
- [x] `bun test tests/sse-parser.test.ts` зелёный.
- [x] `bun test` все остальные тесты зелёные.
- [ ] `bun run tests/integration.live.ts` end-to-end проходит, streaming chat работает (UI получает токены).
- [x] Grep `JSON.parse(.*data: ` в `src/providers/` → 0 совпадений (всё через парсер).
