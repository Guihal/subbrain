# 01. Скелет сервера: Bun + Elysia

> Статус: ⬜ Не начато

## Цель

Минимальный OpenAI-совместимый прокси-сервер, который принимает запросы от VS Code (Continue/Cursor) и проксирует их к NVIDIA NIM API с SSE-стримингом.

## Требования

- `POST /v1/chat/completions` — основной эндпоинт (SSE streaming + non-streaming)
- `GET /v1/models` — список доступных «виртуальных» моделей (ролей)
- `POST /v1/embeddings` — проксирование к NVIDIA embedding API
- Корректная обработка `stream: true` / `stream: false`
- Прозрачная передача SSE-чанков от NVIDIA → клиенту

## Стек

- **Runtime:** Bun
- **Framework:** Elysia
- **Upstream:** `https://integrate.api.nvidia.com/v1`

## Конфигурация

```
NVIDIA_API_KEY=nvapi-...
NVIDIA_BASE_URL=https://integrate.api.nvidia.com/v1
PROXY_PORT=4000
PROXY_AUTH_TOKEN=<local bearer token>
```

## Структура файлов (предварительная)

```
src/
  index.ts              # Точка входа, Elysia app
  routes/
    chat.ts             # POST /v1/chat/completions
    models.ts           # GET /v1/models
    embeddings.ts       # POST /v1/embeddings
  providers/
    types.ts            # Интерфейс LLMProvider
    nvidia.ts           # Реализация для NVIDIA NIM
    index.ts            # Фабрика: создаёт провайдер по конфигу
  lib/
    sse.ts              # SSE stream transformer
```

## Абстракция LLM-провайдера

Вся работа с внешним API идёт через интерфейс `LLMProvider`. Сейчас единственная реализация — NVIDIA NIM, но обёртка позволяет добавить другой провайдер (OpenRouter, локальный Ollama, и т.д.) без переписывания роутов и pipeline.

```typescript
interface LLMProvider {
  chat(params: ChatParams): Promise<ChatResponse>;
  chatStream(params: ChatParams): AsyncIterable<ChatChunk>;
  embed(params: EmbedParams): Promise<EmbedResponse>;
  rerank(params: RerankParams): Promise<RerankResponse>;
  listModels(): Promise<ModelInfo[]>;
}

interface ChatParams {
  model: string;
  messages: Message[];
  temperature?: number;
  max_tokens?: number;
  tools?: Tool[];
}
```

Role → model маппинг (docs/03) работает **выше** провайдера: роутер подставляет конкретную модель, провайдер просто отправляет запрос.

## Открытые вопросы

- [ ] Формат ошибок: проксировать NVIDIA-ошибки as-is или оборачивать?
- [ ] Timeout на upstream-запросы?
- [ ] Health check эндпоинт (`GET /health`)?
