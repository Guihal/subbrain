# Задача 10 — Splitting `packages/core/packages/core/packages/core/src/db/index.ts` → `db/tables/*`

**Оценка:** 0.5 дня
**Зависимости:** —
**Status:** DONE

## Цель

[packages/core/packages/core/src/db/index.ts](../../../packages/core/packages/core/src/db/index.ts) ~716 строк смешивает CRUD по 5+ таблицам. Разнести по таблице на файл; сам `index.ts` собирает класс `MemoryDB` из mixin'ов / композитов.

## Целевая структура

```
packages/core/src/db/
├── index.ts            # MemoryDB orchestrator: open + migrate + сборка методов из tables/*
├── schema.ts           # уже есть — миграции v1..v3 (после MED-10 — в транзакции)
├── tables/
│   ├── memory.ts       # Layer 1..3: focus / shared_memory / context / archive / agent
│   ├── chats.ts        # chat rooms + messages (chats, chat_messages)
│   ├── logs.ts         # raw_log (Layer 4) — write-only API
│   ├── kv.ts           # key-value: night_cycle_last_processed_id, и т.п.
│   └── users.ts        # auth-related, если есть; иначе файл не создавать
└── types.ts            # row-типы: SharedRow, ContextRow, ArchiveRow, ChatRow, LogRow
```

## Что куда

### `tables/memory.ts`
- Все методы: `getFocus / setFocus / insertShared / getShared / searchShared / updateShared / deleteShared / insertContext / ... / insertArchive / updateArchive / insertAgent`.
- Отдельный allow-list колонок (для PR 05 MED-1):
  ```ts
  export const SHARED_UPDATABLE = new Set(["text", "tags", "weight"]);
  export const CONTEXT_UPDATABLE = new Set(["text", "tags", "session_id"]);
  // ...
  ```

### `tables/chats.ts`
- `createChat / getChat / listChats / deleteChat / appendMessage / updateChatMessage / getMessages`.

### `tables/logs.ts`
- `appendLog(stage, message, meta)` — единственный write метод.
- `getRecentLog(sinceHours)` — read для night-cycle и `report_context` (PR из tasks/01).

### `tables/kv.ts`
- `kvGet(key) / kvSet(key, value)` — простой store для guard'ов.

### `tables/users.ts` (если применимо)
- Текущая `users` таблица если есть; иначе пропустить.

### `index.ts` (orchestrator)
```ts
export class MemoryDB {
  db: Database;

  constructor(path: string) {
    this.db = new Database(path);
    migrate(this.db);                 // schema.ts
    loadSqliteVec(this.db);
  }

  // Композиция: либо mixins, либо явные обёртки:
  // вариант A — mixins
  // вариант B — явный делегат:
  getFocus = bindFocus(this);
  setFocus = bindSetFocus(this);
  insertShared = bindInsertShared(this);
  // ...
}
```

Вариант B (явный) — проще читать, IDE go-to-def сразу ведёт в нужный файл, без магии mixin'ов. Идём так.

## Риски

- Импорты по всему репо: `import { db } from "@/db"` — должны продолжать работать; меняем только внутренности.
- `MemoryDB` экспортируется как тип в нескольких местах — проверить, что публичный API не уехал.
- Транзакции (MED-10 + HIGH-6) обращаются к `this.db.transaction(...)` — каждый файл `tables/*` получает доступ через `this.db`, не через свой `Database`-экземпляр.
- FTS5 + sqlite-vec расширения загружаются один раз в конструкторе.

## Тесты

- Существующие `tests/db.test.ts` — все продолжают зеленеть.
- Дополнительно `tests/db-tables-isolation.test.ts` (smoke): импорт каждого `tables/*.ts` отдельно → нет circular import warnings.

## Файлы

- [packages/core/packages/core/src/db/index.ts](../../../packages/core/packages/core/src/db/index.ts) (сильно сократить)
- `packages/core/src/db/tables/memory.ts`, `tables/chats.ts`, `tables/logs.ts`, `tables/kv.ts`, `tables/users.ts?`
- `packages/core/packages/core/packages/core/src/db/types.ts` (новый)
- [packages/core/packages/core/src/db/schema.ts](../../../packages/core/packages/core/src/db/schema.ts) — не трогать (только если PR 05 MED-10 ещё не закрыт — там обернуть v3 в транзакцию)
- [CLAUDE.md](../../../CLAUDE.md) — обновить упоминания `packages/core/packages/core/packages/core/src/db/index.ts` и пути миграций.
- [docs/completed/02-database-schema.md](../../completed/02-database-schema.md) — обновить структуру.

## Порядок исполнения

1. Завести `packages/core/packages/core/packages/core/src/db/types.ts` с row-типами (вытащить из существующего `index.ts`).
2. Вынести `tables/kv.ts` (самый маленький, минимальный риск).
3. Вынести `tables/logs.ts`.
4. Вынести `tables/chats.ts`.
5. Вынести `tables/memory.ts` (самый большой).
6. Сократить `index.ts` до orchestrator'а.
7. Прогон полного `bun test` после каждого шага.

## Приёмка

- [ ] `bunx tsc --noEmit` = 0.
- [ ] `bun test` зелёные.
- [ ] `wc -l packages/core/packages/core/src/db/index.ts` ≤ 150.
- [ ] Все файлы в `db/tables/` ≤ 250 строк.
- [ ] `bun run tests/integration.live.ts` end-to-end проходит.
- [ ] `bun run scripts/audit-db.ts` без ошибок.
