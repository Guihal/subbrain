# Задача 26a — Service слой: Chat (LAYER-3)

**Оценка:** 0.5 дня
**Зависимости:** 25a
**Status:** DONE (PR #26a)

## Цель

Вынести оркестрацию «direct vs pipeline mode, compressor, chat persistence» из `routes/chat.ts` в `ChatService`. Route — только TypeBox + SSE-выхлоп + вызов сервиса.

## Файлы

- [packages/agent/src/services/chat.service.ts](../../../packages/agent/src/services/chat.service.ts) — новый.
- [packages/server/packages/server/src/routes/chat.ts](../../../packages/server/packages/server/src/routes/chat.ts) — становится thin.
- [packages/server/packages/server/src/app/deps.ts](../../../packages/server/packages/server/src/app/deps.ts) — инстанцирует `ChatService`.

## Изменение

### 1. `packages/agent/src/services/chat.service.ts`

```
class ChatService {
  constructor(
    private router: ModelRouter,
    private pipeline: AgentPipeline,
    private memory: MemoryDB,
  ) {}

  async handleCompletion(req: ChatCompletionRequest, meta: { chatId?, source, directModeForced? }): Promise<ChatCompletionResponse>;
  createStream(req: ChatCompletionRequest, meta): AsyncIterable<SSEChunk>;
}
```

Внутри: всё что сейчас делает `routes/chat.ts` — normalizeMessages, вычисление `directMode` (через `isOverloadedFor(provider)` — см. PR 23), выбор pipeline vs raw `router.chat`, chat persistence через `wrapStreamForChat`.

### 2. `routes/chat.ts` — thin

```
export function chatRoute(chatService: ChatService) {
  return new Elysia().post("/v1/chat/completions", async ({ body, headers, set }) => {
    const meta = extractMeta(headers);   // chatId, source, directModeForced
    if (body.stream) {
      const stream = chatService.createStream(body, meta);
      return sseResponse(stream, set);
    }
    return chatService.handleCompletion(body, meta);
  }, { body: ChatCompletionRequestSchema });
}
```

### 3. `deps.ts`

```
const chatService = new ChatService(router, pipeline, memory);
```

## Тесты

`tests/chat-service.test.ts`:

- Unit на mock deps.
- `handleCompletion({model: "teamlead", ...}, {})` с non-overloaded router — вызывает `pipeline.execute`.
- `handleCompletion({...}, {directModeForced: true})` — вызывает `router.chat` напрямую.
- `createStream` — возвращает async iterable, chunks валидный SSE.

`tests/chat-contract.test.ts` (live-compatible):

- HTTP `POST /v1/chat/completions` shape не изменён.
- Streaming content-type `text/event-stream`.

## Приёмка

- [ ] `bunx tsc --noEmit` = 0.
- [ ] Оба теста зелёные.
- [ ] `wc -l packages/server/packages/server/src/routes/chat.ts` <= 80.
- [ ] Все старые тесты chat остаются зелёными.
- [ ] LAYER-3 вычеркнут в [docs/02-audit.md](../../02-audit.md).

## Deploy note

```bash
ssh root@109.120.187.244
cd /opt/subbrain
git pull
docker compose build && docker compose up -d
```
