# Задача 23 — DirectMode per-provider + optional provider startup (ROUTE-1)

**Оценка:** 3–4 часа
**Зависимости:** —
**Status:** DONE (PR #23)

## Цель

Два связанных, но раздельных дефекта:

### 23a — directMode триггерится не тем провайдером

[packages/server/src/routes/chat.ts:31-33](../../../packages/server/src/routes/chat.ts#L31-L33) — `directMode = headers["x-direct-mode"] === "true" || router.isOverloaded`.

[packages/core/src/lib/model-router.ts:61-63](../../../packages/core/src/lib/model-router.ts#L61-L63) — `get isOverloaded` смотрит **только на NVIDIA** limiter (`availableSlots < 8`).

Но все virtual roles сейчас primary=MiniMax ([packages/core/src/lib/model-map.ts:21-52](../../../packages/core/src/lib/model-map.ts#L21-L52)). Когда NVIDIA перегружена (RAG/embed/rerank занял слоты), чат идёт через MiniMax, но **внезапно переключается в direct mode** — обходит agent-pipeline, память, executive summary. Пользователь получает сырой ответ от MiniMax без исполнительного контекста.

### 23b — startup требует недоступные провайдеры

[packages/providers/src/index.ts:23+](../../../packages/providers/src/index.ts#L23) — создаёт `nvidia`, `openrouter`, `copilot` вне зависимости от того, используются ли они. Если в окружении нет `COPILOT_TOKEN` / `OPENROUTER_API_KEY` — сервер падает на старте.

В текущей model-map-раскладке Copilot и OpenRouter нигде не primary, только как fallback → их фактически не вызывают, но ключи всё равно обязательны.

## Файлы

- [packages/core/src/lib/model-router.ts](../../../packages/core/src/lib/model-router.ts) — `isOverloadedFor(provider)` + deprecation `isOverloaded`.
- [packages/server/src/routes/chat.ts](../../../packages/server/src/routes/chat.ts) — `resolveModel(...).provider` и `isOverloadedFor(...)`.
- [packages/providers/src/index.ts](../../../packages/providers/src/index.ts) — optional loading.

## Изменение

### 23a

1. `ModelRouter.isOverloadedFor(provider: ProviderName): boolean`:
   - `backend = this.backends[provider]`
   - Если `backend` отсутствует (provider не загружен) → `false` (ничего не перегружено потому что не работает; отдельная ошибка случится при вызове chat).
   - Иначе `backend.limiter.availableSlots < RESERVED_SLOTS` (текущий `< 8`).
2. `isOverloaded` (старый getter) — оставить как alias `isOverloadedFor("nvidia")` для back-compat, помечен `@deprecated`.
3. `routes/chat.ts`:
   - `import { resolveModel } from "../lib/model-map"` (уже может быть).
   - `const { provider } = resolveModel(requestedModel);`
   - `const directMode = headers["x-direct-mode"] === "true" || router.isOverloadedFor(provider);`

### 23b

1. `loadProviders(config)` → вычисляет required-set:
   - Обходит `MODEL_MAP` — собирает все `primaryProvider` + `fallbackProvider`.
   - NVIDIA — **mandatory** пока RAG/embed/rerank включены (читай: всегда, потому что хотя бы post-hippocampus embed вызывается).
   - Для каждого не-NVIDIA provider:
     - Если использован (primary/fallback) И ключ есть в env → load.
     - Если использован И ключа нет → **fail-fast**.
     - Если НЕ использован (model-map никак его не ссылается) → skip.
2. Результат — `Backends` object с только загруженными провайдерами. `ModelRouter` при resolve-неизвестного-провайдера ловит ошибку и бросает `UpstreamExhaustedError` (типизированный провайдер вместо раннего фолбэка на NVIDIA).

## Тесты

`tests/router-overload-per-provider.test.ts`:

- Создать router с mock limiter-ами. Nvidia: 5 availableSlots. MiniMax: 15 availableSlots.
- `router.isOverloadedFor("nvidia")` = true.
- `router.isOverloadedFor("minimax")` = false.
- `router.isOverloaded` (deprecated alias) = true.

`tests/chat-direct-mode.test.ts`:

- Stub router + chat pipeline.
- Request model='teamlead' (primary=minimax); router: minimax free, nvidia overloaded. Assert pipeline mode активен (НЕ direct).
- Request model='nvidia-only' (если такой есть); nvidia overloaded. Assert direct mode.

`tests/provider-optional-startup.test.ts`:

- Env has NVIDIA + MINIMAX. Нет COPILOT, нет OPENROUTER.
- model-map = все роли primary=minimax/fallback=nvidia → startup проходит без ошибок.
- Если mutate model-map тест-копию — role с fallbackProvider="copilot" + нет COPILOT_TOKEN → throw на старте.

## Приёмка

- [ ] `bunx tsc --noEmit` = 0.
- [ ] Все новые тесты зелёные.
- [ ] Dev-старт без `COPILOT_TOKEN` + без `OPENROUTER_API_KEY` работает (при условии что model-map не ссылается на них primary/fallback).
- [ ] Manual smoke: NVIDIA overload (например `scripts/seed.ts` гоняется параллельно) → chat через teamlead остаётся в pipeline mode (проверить `x-chat-source` / логи).
- [ ] ROUTE-1 вычеркнут в [docs/02-audit.md](../../02-audit.md).

## Deploy note

```bash
ssh root@109.120.187.244
cd /opt/subbrain
git pull
docker compose build && docker compose up -d
```

## Known follow-ups

- Если в будущем захочется «RAG-off» режим (совсем без NVIDIA) — нужно вынести rerank/embed в optional. Отдельная задача, выходит за этот PR.
