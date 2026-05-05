# 28-W3-3 — split `db/tables/memory.ts` (451 → split-folder)

**Status:** OPEN. Master: [28-file-size-150-limit.md](28-file-size-150-limit.md) Wave 3.

**Order:** parallel with W3-4. Prereq for W3-2.

## Цель

Разбить `packages/core/src/db/tables/memory.ts` (451 LOC) на split-folder. Public API = `MemoryTable` class — сохранить все методы 1:1.

## Файлы

**Удалить**:
- `packages/core/src/db/tables/memory.ts`

**Создать**:
- `packages/core/src/db/tables/memory/index.ts` — `MemoryTable` orchestrator class (≤120 LOC). Конструктор + thin делегации в submodules.
- `packages/core/src/db/tables/memory/insert.ts` — `insertContext(...)`, `insertArchive(...)`, `insertAgent(...)` (CRUD insert по 5 слоям). Pure functions taking `db` + params.
- `packages/core/src/db/tables/memory/update.ts` — `updateContext(...)`, `updateArchive(...)`, `updateAgent(...)` + helpers (ALLOW maps for `updateRow`).
- `packages/core/src/db/tables/memory/select.ts` — `getContext`, `getArchive`, `getAgent`, `listContext`, `listArchive`, `listAgent`, `count*` helpers.
- `packages/core/src/db/tables/memory/delete.ts` — `deleteContext`, `deleteArchive`, `deleteAgent`.
- `packages/core/src/db/tables/memory/schema-helpers.ts` — type/row mapping helpers (если есть `mapRowToContext`/`mapRowToArchive` etc).

**Trigger**: `scripts/check-file-size.ts` `"packages/core/src/db/tables/memory.ts": 452` → удалить.

## Изменение

1. Класс `MemoryTable` в `index.ts` хранит `db: Database` + prepared statements (если есть).
2. Submodules — pure functions, принимающие `db: Database` + params. Без классов.
3. Никаких изменений семантики — пословный перенос.
4. Все consumers (`MemoryRepository`, scripts, tests) импортируют через `~/db/tables/memory` — auto-resolve через index.ts.

## Тесты

- `rm -f data/test.db && bun test tests/migration*.test.ts tests/schema*.test.ts` — green.
- `bun test` — без regression (838/0).

## Приёмка

Из repo root, exit 0:

1. `bun run scripts/check-file-size.ts` — все split-файлы ≤150, transitional entry удалена.
2. `bun run scripts/check-deep-imports.ts` — без regression.
3. `bunx tsc --noEmit` — clean.
4. `bun test tests/repo-rules.test.ts` — 5/5.
5. `bun test` — без новых failed.
6. Migration safety: `rm -f data/test.db && bun test tests/migration*.test.ts` green.

## Constraints

- Scope-lock: только файлы в §Файлы.
- Public API стабилен: `MemoryTable` class same methods.
- Никаких изменений в `db/schema.ts` или migrations.
