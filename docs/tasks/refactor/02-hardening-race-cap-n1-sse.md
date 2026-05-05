# Задача 02 — Hardening: race / cap / N+1 / SSE (HIGH-1/4/7/9)

**Оценка:** 1 день
**Зависимости:** после PR 01 (общие абстракции signal + tool timeout уже на месте)
**Status:** DONE

## Цель

Устранить гонку в rate-limiter, отсутствие потолка fallback-цепочки, N+1 в RAG и запись в БД после закрытия клиента.

## Пункты

### HIGH-1 — атомарный `tryAcquire()` в rate-limiter

**Файл:** [packages/providers/src/rate-limiter.ts](../../../packages/providers/src/rate-limiter.ts)

- Сейчас две асинхронные проверки `hasBudget` → `consume` — между ними другой caller может превысить лимит.
- Под `Map<provider, Mutex>` (или `async-mutex` / ручной семафор на `queueMicrotask`) реализовать:
  ```ts
  tryAcquire(provider): Promise<{ok: true, release: () => void} | {ok: false, waitMs: number}>
  ```
- `ModelRouter`: при `ok=false` ждёт `waitMs` либо переключается на fallback.

**Тест:** `tests/rate-limiter.test.ts` — 100 параллельных `tryAcquire()` при лимите 10 RPM → ровно 10 получают `ok:true`.

### HIGH-4 — `MAX_FALLBACK_ATTEMPTS=1`

**Файл:** [packages/core/src/lib/model-router.ts](../../../packages/core/src/lib/model-router.ts)

- Сейчас цепочка fallback может уходить вглубь неограниченно при 4xx от провайдера.
- Ввести константу `MAX_FALLBACK_ATTEMPTS = 1`. После 2-го 4xx подряд → `throw new UpstreamExhaustedError({ lastStatus, lastBody })` → в HTTP-роутинге 502 c `{ error: { code: "upstream_exhausted" } }`.
- Direct-mode ловит `UpstreamExhaustedError` и возвращает клиенту **без** дополнительных переключений цепочки (иначе direct теряет смысл).

**Тест:** `tests/model-router.test.ts` — мок-провайдер кидает 429 подряд → через 2 попытки `UpstreamExhaustedError`.

### HIGH-7 — batch vecSearch + кэш recency

**Файл:** [packages/agent/packages/agent/src/rag/pipeline/index.ts](../../../packages/agent/packages/agent/src/rag/pipeline/index.ts)

- Сейчас `vecSearch` делает по SELECT на каждый id → до 60 SELECT'ов на RAG-запрос.
- Заменить на один `WHERE id IN (?,?,…)` (batch, параметризованный список).
- `getRecencyBoost` читает `updated_at` уже из `RAGResult` — забирать его в первом SELECT и мутировать в объект (кэш).

**Тест:** `tests/rag.test.ts` — спай на `db.prepare()`; один гибридный поиск → ≤ 3 `prepare()` вызова (FTS + vec batch + rerank meta).

### HIGH-9 — SSE write-after-close в `wrapStreamForChat`

**Файл:** [packages/server/packages/server/src/routes/chat.ts](../../../packages/server/packages/server/src/routes/chat.ts), функция `wrapStreamForChat`

- Сейчас: клиент дисконнектится на 3-м chunk, но `db.updateChatMessage` продолжает писать остаток — в БД сохраняется частичный ответ.
- Ввести флаг `isClosed` (замкнут на `signal.aborted || ws.closed`). После срабатывания — запретить `db.updateChatMessage`.

**Тест:** `tests/chat-stream.test.ts` — long-stream, клиент дисконнектится на 3-м chunk'е (`AbortController.abort()`), БД не содержит сообщения или содержит только первые 3 chunk'а, но **не растёт** после disconnect.

## Файлы

- [packages/providers/src/rate-limiter.ts](../../../packages/providers/src/rate-limiter.ts)
- [packages/core/src/lib/model-router.ts](../../../packages/core/src/lib/model-router.ts)
- [packages/agent/packages/agent/src/rag/pipeline/index.ts](../../../packages/agent/packages/agent/src/rag/pipeline/index.ts)
- [packages/server/packages/server/src/routes/chat.ts](../../../packages/server/packages/server/src/routes/chat.ts)
- [packages/core/src/lib/errors.ts](../../../packages/core/src/lib/errors.ts) или аналог — новый `UpstreamExhaustedError`
- `tests/rate-limiter.test.ts`, `tests/model-router.test.ts`, `tests/rag.test.ts`, `tests/chat-stream.test.ts`

## Порядок исполнения

1. HIGH-1 (мьютекс) — критичная гонка. Отдельный коммит.
2. HIGH-4 (cap fallback) — новый error-тип + единая точка throw в `model-router`.
3. HIGH-7 (RAG N+1) — измерения до/после в PR-описании.
4. HIGH-9 (SSE) — требует internal abort-signal'а, уже добавленного в PR 01.

## Приёмка

- [ ] `bunx tsc --noEmit` = 0.
- [ ] `bun test` — все новые тесты + существующие.
- [ ] Нагрузочный smoke: 50 параллельных запросов к одному провайдеру → лимит не превышается, ошибок «превышение бюджета» нет в логе.
- [ ] Ручной smoke: отключить интернет → после второй 4xx клиент получает 502 `upstream_exhausted`, не висит.
- [ ] Вычеркнуть HIGH-1, HIGH-4, HIGH-7, HIGH-9 в [docs/02-audit.md](../../02-audit.md).
