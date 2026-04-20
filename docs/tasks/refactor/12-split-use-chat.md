# Задача 12 — Splitting `web/app/composables/useChat.ts`

**Оценка:** 0.5 дня
**Зависимости:** —
**Status:** TODO

## Цель

[web/app/composables/useChat.ts](../../../web/app/composables/useChat.ts) — 430 строк, mixing reactive state, SSE-парсинг, persistence (CRUD комнат) и режимы (pipeline/direct/agent + max_steps). Разнести по одной ответственности.

## Целевая структура

```
web/app/composables/
├── useChat.ts              # фасад: импортирует и переэкспортирует под одним именем
├── useChatState.ts         # reactive messages + текущий room
├── useChatStream.ts        # fetch SSE + parse chunks + append-to-messages
├── useChatPersistence.ts   # save/load rooms через REST
└── useChatMode.ts          # mode (pipeline/direct/agent) + max_steps + headers
```

## Что куда

### `useChatState.ts`
```ts
export function useChatState() {
  const messages = useState<Message[]>("chat:messages", () => []);
  const currentRoomId = useState<number | null>("chat:room", () => null);
  const isStreaming = useState("chat:streaming", () => false);

  function appendUserMessage(text: string) {
    messages.value.push({ role: "user", content: text, ts: Date.now() });
  }

  function appendAssistantPlaceholder() {
    messages.value.push({ role: "assistant", content: "", ts: Date.now() });
  }

  function appendChunkToLast(chunk: string) {
    const last = messages.value[messages.value.length - 1];
    if (last?.role === "assistant") last.content += chunk;
  }

  function reset() { messages.value = []; currentRoomId.value = null; }

  return { messages, currentRoomId, isStreaming, appendUserMessage, appendAssistantPlaceholder, appendChunkToLast, reset };
}
```

### `useChatStream.ts`
- `streamChat(req): AsyncIterable<ChatChunk>` — fetch SSE, парсит каждый chunk (`data: ...`), эмитит `{type: "delta" | "done" | "error", payload}`.
- Использует существующий `EventSource` или `ReadableStream.getReader()`.
- Не знает про state — caller сам кладёт chunks в state.

### `useChatPersistence.ts`
- `loadRoom(id)`, `saveRoom(messages)`, `listRooms()`, `deleteRoom(id)`.
- Использует `useApi()` для авторизованных запросов.

### `useChatMode.ts`
- `mode: "pipeline" | "direct" | "agent"` — `useState`.
- `maxSteps: number` (default 12 — текущий UI default).
- `buildHeaders(): Headers` — собирает `X-Direct-Mode: true` для `direct` режима, etc.

### `useChat.ts` (тонкий фасад)
```ts
export function useChat() {
  const state = useChatState();
  const mode = useChatMode();
  const persistence = useChatPersistence();

  async function send(text: string) {
    state.appendUserMessage(text);
    state.appendAssistantPlaceholder();
    state.isStreaming.value = true;
    try {
      const headers = mode.buildHeaders();
      for await (const chunk of streamChat({ messages: state.messages.value, headers, maxSteps: mode.maxSteps.value })) {
        if (chunk.type === "delta") state.appendChunkToLast(chunk.payload);
        if (chunk.type === "done") break;
      }
      await persistence.saveRoom(state.currentRoomId.value, state.messages.value);
    } finally {
      state.isStreaming.value = false;
    }
  }

  return { ...state, ...mode, ...persistence, send };
}
```

## Риски

- Все потребители `useChat()` сейчас деструктурируют конкретные поля — фасад должен экспортировать **всё** что было раньше, иначе сломаются компоненты-потребители.
- Inflight stream при переключении комнаты — не забыть aborter в `useChatState.reset()`.
- Reactive ссылки между composables: `useState` ключи должны совпадать → используются singletons (Nuxt автоматически кэширует).

## Тесты

UI-тестов в проекте нет. Ручной smoke:
- Открыть чат → отправить сообщение → ответ приходит chunked.
- Переключить mode на `agent` → запрос с `max_steps`, тулы видны.
- Переключить mode на `direct` → быстрый ответ без pre/post.
- Переключиться между комнатами → `messages` сброшены, заново загружены.
- Дисконнект в середине streaming (закрыть вкладку → переоткрыть) → сохранилась корректная история (без частичного ответа после PR 02 HIGH-9).

## Файлы

- [web/app/composables/useChat.ts](../../../web/app/composables/useChat.ts) (переписать тонко)
- `web/app/composables/useChatState.ts` (новый)
- `web/app/composables/useChatStream.ts` (новый)
- `web/app/composables/useChatPersistence.ts` (новый)
- `web/app/composables/useChatMode.ts` (новый)
- [web/app/components/ChatSidebar.vue](../../../web/app/components/ChatSidebar.vue) — проверить, не сломались импорты.

## Порядок исполнения

1. Вынести `useChatState.ts` — изоляция реактивного состояния.
2. Вынести `useChatMode.ts` — мелкий, без зависимостей.
3. Вынести `useChatPersistence.ts`.
4. Вынести `useChatStream.ts` — самое сложное (SSE-парсинг).
5. Сократить `useChat.ts` до фасада, прогнать smoke.

## Приёмка

- [ ] `bunx tsc --noEmit` = 0.
- [ ] `bun test` зелёные.
- [ ] `wc -l web/app/composables/useChat.ts` ≤ 80.
- [ ] Все новые composables ≤ 250 строк.
- [ ] Ручной smoke: 5 кейсов выше проходят.
