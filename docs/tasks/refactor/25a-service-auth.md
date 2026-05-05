# Задача 25a — Service слой: Auth (LAYER-1)

**Оценка:** 3 часа
**Зависимости:** 17
**Status:** DONE (PR 25a)

## Цель

Первый срез «routes → services»: вынести auth-логику из middleware/routes в `AuthService`. Routes не должны знать про `createHash` и `timingSafeEqual` — они дёргают сервис.

Это маленький прагматичный срез — не полная миграция на DDD. Доказывает паттерн, дальше по главе 16 распространяется на memory/chat/agent.

## Файлы

- [packages/core/packages/agent/src/services/auth.service.ts](../../../packages/core/packages/agent/src/services/auth.service.ts) — новый файл.
- [packages/core/src/lib/auth.ts](../../../packages/core/src/lib/auth.ts) — становится тонкий: middleware делегирует.
- [packages/server/packages/server/src/app/deps.ts](../../../packages/server/packages/server/src/app/deps.ts) — инстанцирует `AuthService` и пробрасывает в middleware + decoration.
- [packages/server/packages/server/src/app/bootstrap.ts](../../../packages/server/packages/server/src/app/bootstrap.ts) — middleware получает `authService` вместо raw `token`.

## Изменение

### 1. `packages/core/packages/core/packages/agent/src/services/auth.service.ts`

```
export class AuthService {
  private expectedHash: Uint8Array;

  constructor(private token: string) {
    this.expectedHash = hashSync(token);
  }

  validateBearer(header: string | null): boolean {
    if (!header) return false;
    const bearer = header.replace(/^Bearer\s+/i, "");
    return timingSafeCompare(this.expectedHash, hashSync(bearer));
  }

  getToken(): string { return this.token; }   // для /api/token endpoint
}
```

Внутрикодовые утилиты `hashSync` / `timingSafeCompare` живут приватно в модуле, не экспортируются. Раньше дублировались между `auth.ts` и `telegram/userbot.ts` — унифицируется тут.

### 2. `lib/auth.ts` → middleware-адаптер

```
export function authMiddleware(authService: AuthService) {
  return new Elysia({ name: "auth" }).onBeforeHandle(
    { as: "global" },
    ({ request, path }) => {
      if (path === "/health") return;
      if (path === "/" || path === "/index.html" || path.startsWith("/public/")) return;
      if (path === "/telegram/webhook") return;

      const header = request.headers.get("authorization");
      if (!authService.validateBearer(header)) {
        return new Response(
          JSON.stringify({ error: { message: "Unauthorized" } }),
          { status: 401, headers: { "Content-Type": "application/json" } }
        );
      }
    }
  );
}
```

Middleware больше не знает про `createHash`.

### 3. `deps.ts`

```
const authService = new AuthService(config.authToken);
...
return { ..., authService };
```

### 4. `bootstrap.ts`

`/api/token` endpoint → `{ token: authService.getToken() }`. Middleware вызов → `authMiddleware(authService)`.

## Тесты

`tests/auth-service.test.ts`:

- `new AuthService("abc")` + `validateBearer("Bearer abc")` = true.
- `validateBearer("Bearer wrong")` = false.
- `validateBearer("Bearer abcd")` (другая длина) = false (без throw).
- `validateBearer(null)` = false.
- `validateBearer("Basic abc")` (не bearer) = false.
- Taming-safe смоук: measure 1000 iter правильного vs неправильного → разница < 10%.

## Приёмка

- [ ] `bunx tsc --noEmit` = 0.
- [ ] Тесты зелёные.
- [ ] `grep -n 'createHash\|timingSafeEqual' packages/core/src/lib/auth.ts packages/server/packages/server/src/app/bootstrap.ts packages/server/src/routes/*.ts` — 0 совпадений (только в `services/auth.service.ts`).
- [ ] Все тесты `auth-coverage.test.ts` (из PR 17) остаются зелёными.
- [ ] LAYER-1 вычеркнут в [docs/02-audit.md](../../02-audit.md).

## Deploy note

```bash
ssh root@109.120.187.244
cd /opt/subbrain
git pull
docker compose build && docker compose up -d
```

## Паттерн для последующих сервисов

Все service-файлы в `packages/agent/src/services/*.service.ts`. Зависимости получают в ctor. Не знают про Elysia/HTTP. Routes делают только TypeBox + shape + delegation. `deps.ts` — место где сервисы собираются.
