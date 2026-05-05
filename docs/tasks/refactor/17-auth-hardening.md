# Задача 17 — Auth hardening (AUTH-16)

**Оценка:** 2 часа
**Зависимости:** —
**Status:** DONE (PR 17)

## Цель

Три endpoint-а объявлены в Elysia-цепочке ДО `authMiddleware` → доступны без токена. Плюс middleware глобально пропускает `/telegram/*` по префиксу → админ-ручки webhook совсем голые.

Доступ без auth к:
- `GET /api/token` ([packages/server/src/app/bootstrap.ts:103](../../../packages/server/src/app/bootstrap.ts#L103)) — возвращает `{ token: config.authToken }`. Bearer-секрет утекает любому кто может постучать на порт.
- `POST /night-cycle` ([packages/server/src/app/bootstrap.ts:93](../../../packages/server/src/app/bootstrap.ts#L93)) — триггерит цикл: реальный CPU/LLM-бюджет.
- `GET /night-cycle/status` ([packages/server/src/app/bootstrap.ts:98](../../../packages/server/src/app/bootstrap.ts#L98)) — раскрывает внутреннее состояние.
- `POST /telegram/set-webhook` ([packages/server/src/routes/telegram.ts:44](../../../packages/server/src/routes/telegram.ts#L44)) — репоинт бота на произвольный URL.
- `POST /telegram/remove-webhook` ([packages/server/src/routes/telegram.ts:50](../../../packages/server/src/routes/telegram.ts#L50)) — отключение бота.

Корневая причина — [packages/core/src/lib/auth.ts:28](../../../packages/core/src/lib/auth.ts#L28): `if (path.startsWith("/telegram/")) return` игнорирует префикс целиком. Должно быть только `/telegram/webhook`.

## Файлы

- [packages/server/src/app/bootstrap.ts](../../../packages/server/src/app/bootstrap.ts) — переставить endpoint-ы за `authMiddleware`.
- [packages/server/src/routes/telegram.ts](../../../packages/server/src/routes/telegram.ts) — split на public (webhook) и admin.
- [packages/core/src/lib/auth.ts](../../../packages/core/src/lib/auth.ts) — сузить bypass до строго `/telegram/webhook`.

## Изменение

1. `telegramRoute(bot)` разделить на два Elysia plug-in:
   - `telegramPublicRoute(bot)` — только `POST /telegram/webhook`. Аутентификация через заголовок `x-telegram-bot-api-secret-token`.
   - `telegramAdminRoute(bot)` — `POST /telegram/set-webhook` + `POST /telegram/remove-webhook`. Без собственной проверки — опирается на Bearer-middleware.
2. В `bootstrap.ts`:
   - ДО `authMiddleware`: `staticPlugin`, `/health`, `/metrics`, `mcpProtocolRoute` (у него своя auth), `telegramPublicRoute`.
   - ПОСЛЕ `authMiddleware`: все остальные, включая `/api/token`, `/night-cycle`, `/night-cycle/status`, `telegramAdminRoute`, все `v1/*` роуты.
3. `auth.ts:28` — заменить `if (path.startsWith("/telegram/"))` на `if (path === "/telegram/webhook")`.

## Тесты

`tests/auth-coverage.test.ts` (новый, `bun:test`, без живого сервера — через `app.handle(Request)`):

- `GET /api/token` без `Authorization` → 401.
- `GET /api/token` с валидным Bearer → 200, body содержит token.
- `POST /night-cycle` без auth → 401.
- `GET /night-cycle/status` без auth → 401.
- `POST /telegram/set-webhook` без auth → 401.
- `POST /telegram/remove-webhook` без auth → 401.
- `POST /telegram/webhook` без secret-token header → 401 (grammy).
- `POST /telegram/webhook` с валидным secret → 200.
- `GET /health` без auth → 200 (должен остаться публичным).
- `GET /` (static index) без auth → 200.

## Приёмка

- [ ] `bunx tsc --noEmit` = 0.
- [ ] `bun test tests/auth-coverage.test.ts` зелёный.
- [ ] `grep -n 'startsWith("/telegram/' packages/core/src/lib/auth.ts` = 0 совпадений.
- [ ] `grep -n '/api/token\|/night-cycle' packages/server/src/app/bootstrap.ts | grep -B2 authMiddleware` показывает middleware ВЫШЕ endpoint-ов.
- [ ] AUTH-16 вычеркнут в [docs/02-audit.md](../../02-audit.md).
- [ ] `Status: DONE (PR #N)` выставлен.

## Deploy note

Deploy 100% manual — GitHub заблокирован:

```bash
ssh root@109.120.187.244
cd /opt/subbrain
git pull      # или rsync
docker compose build && docker compose up -d
docker compose logs -f
```

## Known follow-ups

- MCP protocol endpoints (`mcpProtocolRoute`) используют отдельную проверку внутри, не bearer middleware. Проверить что они действительно защищены — вне рамок PR 17, отдельная задача если найдётся расхождение.
