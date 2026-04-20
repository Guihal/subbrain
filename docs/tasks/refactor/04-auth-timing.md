# Задача 04 — Auth timing-safe compare (HIGH-10)

**Оценка:** 0.5 часа
**Зависимости:** —
**Status:** DONE

## Цель

Сравнение API-токена сейчас уязвимо к timing-атаке: обычный `===` разваливается раньше для несовпадающих префиксов.

## Файл

[src/lib/auth.ts](../../../src/lib/auth.ts), строка ~40.

## Изменение

```ts
import { timingSafeEqual } from "node:crypto";

const expectedHash = await hashToken(process.env.API_TOKEN!);

async function hashToken(t: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t))
  );
}

export async function isValidToken(provided: string): Promise<boolean> {
  const provHash = await hashToken(provided);
  return timingSafeEqual(provHash, expectedHash);
}
```

- Обе стороны хэшируются → длины всегда 32 байта → `timingSafeEqual` не кидает на разной длине.
- `expectedHash` считается один раз при boot.
- Ошибка отсутствия `API_TOKEN` — fail-fast при старте, как сейчас.

## Тесты

`tests/auth.test.ts` (расширить или новый):

- Правильный токен → `true`.
- Неправильный токен той же длины → `false`.
- Неправильный токен другой длины → `false` (не throw).
- Пустая строка → `false`.

## Приёмка

- [x] `bunx tsc --noEmit` = 0.
- [x] `bun test tests/auth.test.ts` зелёный.
- [x] Grep по `=== process.env.API_TOKEN` / `=== expectedToken` → 0 совпадений.
- [x] HIGH-10 вычеркнут в [docs/02-audit.md](../../02-audit.md).
