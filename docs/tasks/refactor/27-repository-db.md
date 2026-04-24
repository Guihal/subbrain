# Задача 27 — Repository слой над `db/tables/*`

**Оценка:** 1 день
**Зависимости:** 10 (done), 25b, 26a, 26b
**Status:** PLANNED

## Цель

Формализовать data-слой. Сейчас сервисы (25b/26a/26b) дёргают `MemoryDB.*` методы, которые — тонкие обёртки над `db/tables/*`. Это де-факто pass-through с одной сигнатурой в миддле. Introduce Repository-классы, так чтобы:

1. Сервисы не видят `MemoryDB` god-объект, только нужные repos.
2. Когда/если будет миграция на Postgres или добавится кэш — меняется только Repository, сервисы не трогаются.
3. Возможно формализованнее ограничение: «сырые SQL живут только в db/tables/ и repos/; вне — запрещено» (grep-guardrail в тестах).

## Файлы

- [src/repositories/](../../../src/repositories/) — новая директория, файлы:
  - `memory.repo.ts` (обёртка над `db/tables/memory.ts`, `shared.ts`, `agent.ts`)
  - `chat.repo.ts` (`db/tables/chats.ts`)
  - `log.repo.ts` (`db/tables/logs.ts`)
  - `telegram.repo.ts` (`db/tables/tg-*`)
  - `freelance.repo.ts` (`db/tables/freelance.ts` если есть)
- [src/services/memory.service.ts](../../../src/services/memory.service.ts) и т.д. — ctor принимает repos.
- [src/app/deps.ts](../../../src/app/deps.ts) — инстанцирует repos.
- [src/db/index.ts](../../../src/db/index.ts) — `MemoryDB` остаётся тонким facade для back-compat переходного периода.

## Изменение

### 1. Example — `memory.repo.ts`

```
export class MemoryRepository {
  constructor(private db: Database) {
    this.shared = new SharedTable(db);
    this.context = new ContextTable(db);
    this.archive = new ArchiveTable(db);
    this.agent = new AgentTable(db);
    this.focus = new FocusTable(db);
    this.embeddings = new EmbeddingsTable(db);
  }

  // Shared
  insertShared(...): void { this.shared.insert(...); }
  getShared(id: string): SharedRow | null { ... }
  getSharedMany(ids: string[]): SharedRow[] { ... }
  listShared(opts): PaginatedResult<SharedRow> { ... }
  patchShared(id, patch): void { updateRow("shared_memory", SHARED_ALLOW, id, patch); }
  // ...

  // Transaction helper (re-export)
  transaction<T>(fn: () => T): T { return this.db.transaction(fn)(); }
}
```

Методы = superset текущих `MemoryDB.*memory*` методов, но scoped. Зеркальная структура для `chat.repo`, `log.repo`, `telegram.repo`.

### 2. Сервисы — swap ctor

```
// services/memory.service.ts
constructor(
  private memoryRepo: MemoryRepository,
  private rag: RAGPipeline,
) {}
```

Все вызовы `this.memory.insertShared(...)` → `this.memoryRepo.insertShared(...)`. Точечная замена.

### 3. `MemoryDB` facade

`src/db/index.ts` — сохраняется, **но** все методы делегируют в repo instances внутри. Back-compat: старый код (`scripts/seed.ts`, `scripts/audit-db.ts` и т.д.) продолжает работать.

### 4. Grep-guardrail

Добавить в `tests/layer-boundary.test.ts`:

```
test("raw SQL lives only in db/tables/ and repositories/", async () => {
  const hits = await grepRepo(`/\b(?:INSERT|UPDATE|DELETE|SELECT)\s/i`, ["src/services/", "src/routes/", "src/pipeline/"]);
  expect(hits).toEqual([]);   // Если non-empty — слой пробит
});
```

## Тесты

`tests/memory-repo.test.ts`:

- CRUD smoke на `data/test.db`: `insertShared`, `getShared`, `getSharedMany`, `patchShared`, `listShared`.
- `transaction` откатывает при throw.

`tests/memory-service-via-repo.test.ts` (regression на 25b):

- `MemoryService` с real `MemoryRepository` — все use-cases 25b работают.

Plus layer-boundary test выше.

## Приёмка

- [ ] `bunx tsc --noEmit` = 0.
- [ ] Новые тесты зелёные.
- [ ] 25b/26a/26b tests остаются зелёными без изменений в самих сервисах (только ctor изменён).
- [ ] Layer-boundary test ловит попытку писать `INSERT INTO ...` в `src/services/` (проверено искусственной инъекцией).
- [ ] `grep -rn 'memory\.\(insert\|update\|delete\|list\|get\|count\|search\)' src/services/ src/routes/` — 0 совпадений (только через repo).
- [ ] `docs/CLAUDE.md` обновлён: упомянуть `src/repositories/` в «Conventions» секции.

## Deploy note

```bash
ssh root@109.120.187.244
cd /opt/subbrain
git pull
docker compose build && docker compose up -d
```

## Что НЕ делаем в этом PR

- Не меняем схему БД.
- Не вводим TypeORM / Prisma / Drizzle. Repository — просто class с методами, под капотом bun:sqlite. Смена ORM — отдельная задача, если вообще случится.
- Не уносим `MemoryDB` — остаётся facade для scripts/ и тестов, которые не стоит переписывать ради граничного перфекционизма.
