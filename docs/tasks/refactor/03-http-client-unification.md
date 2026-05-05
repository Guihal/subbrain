# Задача 03 — HTTP-client унификация (HIGH-8)

**Оценка:** 1 день
**Зависимости:** —
**Status:** DONE

## Цель

Единый `lib/http-client.ts` — `fetchJson<T>(url, init, {timeoutMs, signal})` — заменяет 7 copy-paste мест `fetch` с одинаковым boilerplate (trace-id, retry, timeout).

## Текущее состояние

Места с повторным `fetch`:
- [packages/providers/src/nvidia.ts](../../../packages/providers/src/nvidia.ts) — 2 места (JSON + stream).
- [packages/providers/src/nvidia.ts](../../../packages/providers/src/nvidia.ts).
- [packages/agent/src/rag/pipeline/index.ts](../../../packages/agent/src/rag/pipeline/index.ts) — NVIDIA rerank.
- [packages/agent/src/telegram/bot/index.ts](../../../packages/agent/src/telegram/bot/index.ts) — Bot API.
- [packages/agent/src/telegram/userbot/index.ts](../../../packages/agent/src/telegram/userbot/index.ts) — MTProto-specific, если там есть чистый `fetch` — тоже.
- Возможно [packages/providers/src/bifrost.ts](../../../packages/providers/src/bifrost.ts).

У каждого — свой timeout, свой способ разобрать ошибку, своя обработка 4xx vs 5xx.

## Архитектура

### API

```ts
// packages/core/src/lib/http-client.ts
export interface FetchJsonOpts {
  timeoutMs?: number;       // default 60_000; Copilot stream: 180_000
  signal?: AbortSignal;     // внешний signal (composed with timeout)
  retry?: {
    attempts: number;       // default 0
    on?: (status: number) => boolean;
  };
}

export async function fetchJson<T = unknown>(
  url: string,
  init: RequestInit,
  opts: FetchJsonOpts = {},
): Promise<T>;

export async function fetchStream(
  url: string,
  init: RequestInit,
  opts: FetchJsonOpts = {},
): Promise<Response>;  // возвращает Response для ReadableStream, caller сам парсит
```

### Композиция сигналов

`AbortSignal.timeout(timeoutMs)` + внешний `opts.signal` → `AbortSignal.any([timeoutSignal, userSignal])`. Требует Bun ≥ 1.x (проверить в Dockerfile).

### Ошибки

- HTTP 4xx/5xx → `throw new HttpError(status, bodyText, { url, requestId })`.
- Timeout/abort → `throw new AbortError(reason)` (отличать timeout от user-abort по `signal.reason`).
- JSON-parse fail → `throw new HttpError(200, rawText, { parseError: true })`.

### Trace-id

Автогенерация `x-request-id` при отсутствии; прокидывание в `logger.child({request_id})` (синхронно с PR 13).

## Тесты

**Файл:** `tests/http-client.test.ts` (обязателен по замечанию критика).

Мок-сервер через `Bun.serve()`:
- Success: 200 + JSON → получаем typed объект.
- Timeout: сервер держит 2s, `timeoutMs: 500` → `AbortError` с reason "timeout".
- External abort: вызвать `controller.abort()` через 100ms → `AbortError` с reason "user".
- **Compose (критично):** внешний signal уже `aborted` → `fetchJson` кидает сразу, не делает запрос.
- **Compose race:** параллельные запросы с разными timeoutMs и одним shared user-signal → отмена shared signal'а гасит все, timeout'ы сами по себе не трогают чужие запросы.
- Retry: 503 на первой попытке, 200 на второй → success с `retry: {attempts: 1, on: s => s===503}`.

## Миграция

1. Реализовать `fetchJson` + тесты → PR-able сам по себе.
2. По одному месту переводить `fetch` → `fetchJson` в каждом call-site:
   - `providers/copilot.ts` (и chat, и stream через `fetchStream`)
   - `providers/nvidia.ts`
   - `rag/pipeline.ts` (NVIDIA rerank)
   - `telegram/bot.ts`
3. Прогонять тесты после каждой миграции, чтобы быстро локализовать регрессию.

## Файлы

- [packages/core/src/lib/http-client.ts](../../../packages/core/src/lib/http-client.ts) (новый)
- [packages/core/src/lib/errors.ts](../../../packages/core/src/lib/errors.ts) — `HttpError`, `AbortError`
- `tests/http-client.test.ts` (новый)
- Все 7 call-sites.

## Приёмка

- [ ] `bunx tsc --noEmit` = 0.
- [ ] `bun test tests/http-client.test.ts` — все кейсы (включая compose) зелёные.
- [ ] Grep по `fetch(` в `packages/providers/src/`, `packages/agent/src/rag/`, `packages/agent/src/telegram/` → нет прямых вызовов, только через `fetchJson`/`fetchStream`.
- [ ] Ручной smoke: оборвать сеть во время Copilot-запроса → получаем `AbortError` с timeout, не повисает.
- [ ] HIGH-8 вычеркнут в [docs/02-audit.md](../../02-audit.md).
