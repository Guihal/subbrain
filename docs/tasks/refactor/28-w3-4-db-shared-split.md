# 28-W3-4 — split `db/tables/shared.ts` (396 → split-folder)

**Status:** OPEN. Master: [28-file-size-150-limit.md](28-file-size-150-limit.md) Wave 3.

**Order:** parallel with W3-3. Prereq for W3-2.

## Цель

Разбить `packages/core/src/db/tables/shared.ts` (396 LOC) на split-folder. Public API = `SharedTable` class — сохранить все методы 1:1.

## Файлы

**Удалить**:
- `packages/core/src/db/tables/shared.ts`

**Создать**:
- `packages/core/src/db/tables/shared/index.ts` — `SharedTable` orchestrator class (≤120 LOC).
- `packages/core/src/db/tables/shared/insert.ts` — `insertShared`, `upsertShared` + helper `categoryToKind` если приватный.
- `packages/core/src/db/tables/shared/update.ts` — `updateShared` + ALLOW map.
- `packages/core/src/db/tables/shared/select.ts` — `getShared`, `listShared`, `countShared` + FTS-related selects.
- `packages/core/src/db/tables/shared/delete.ts` — `deleteShared`.

**Trigger**: `scripts/check-file-size.ts` `"packages/core/src/db/tables/shared.ts": 397` → удалить.

## Изменение

1. `SharedTable` class в `index.ts` хранит `db` + prepared statements.
2. Submodules — pure functions, принимающие `db` + params.
3. Никаких изменений семантики.
4. Все consumers — через barrel `~/db/tables/shared`.

## Тесты

- `rm -f data/test.db && bun test tests/migration*.test.ts tests/schema*.test.ts` green.
- `bun test tests/shared-embed-write.test.ts` green.
- `bun test` — без regression (838/0).

## Приёмка

1. `bun run scripts/check-file-size.ts` — split ≤150, transitional удалена.
2. `bun run scripts/check-deep-imports.ts` — green.
3. `bunx tsc --noEmit` — clean.
4. `bun test tests/repo-rules.test.ts` — 5/5.
5. `bun test` — 838/0 baseline.
6. Migration safety: `rm -f data/test.db && bun test tests/migration*.test.ts` green.

## Constraints

- Scope-lock: только файлы в §Файлы.
- Public API: `SharedTable` class methods unchanged.
- Никаких изменений в `db/schema.ts` или migrations.
