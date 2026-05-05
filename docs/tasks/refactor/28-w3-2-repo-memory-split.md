# 28-W3-2 — split `repositories/memory.repo.ts` (380 → split-folder)

**Status:** OPEN. Master: [28-file-size-150-limit.md](28-file-size-150-limit.md) Wave 3.

**Order:** AFTER W3-3 + W3-4 merged. Prereq for W3-1.

## Цель

Разбить `packages/core/src/repositories/memory.repo.ts` (380 LOC) на split-folder. Public API = `MemoryRepository` class — сохранить все методы 1:1.

## Файлы

**Удалить**:
- `packages/core/src/repositories/memory.repo.ts`

**Создать**:
- `packages/core/packages/core/packages/core/src/repositories/memory/index.ts` — `MemoryRepository` orchestrator (≤120 LOC).
- `packages/core/src/repositories/memory/queries.ts` — non-search query proxies (CRUD: get/insert/update/delete по 5 слоям, batch operations).
- `packages/core/src/repositories/memory/search-shared.ts` — `searchShared` + `searchSharedFts` + rerank wiring (если есть).
- `packages/core/src/repositories/memory/search-context.ts` — `searchContext` + `searchContextFts`.
- `packages/core/src/repositories/memory/search-archive.ts` — `searchArchive` + `searchArchiveFts`.
- `packages/core/src/repositories/memory/crud.ts` — `insertContext/Archive/Agent` + `updateContext/Archive/Agent` proxies (если queries.ts перегружен — иначе сюда).

**Trigger**: `scripts/check-file-size.ts` `"packages/core/src/repositories/memory.repo.ts": 381` → удалить.

## Изменение

1. `MemoryRepository` class в `index.ts` — конструктор `(memory: MemoryDB)` + thin делегации в submodule-функции.
2. Submodules — pure functions taking `memory` + params, returning rows / FtsResult arrays.
3. Layer-boundary preserved: repo never calls services / pipeline / routes.
4. Все consumers (`MemoryService`, route handlers) — через `~/repositories/memory`.

## Тесты

- `bun test tests/layer-boundary.test.ts` — green (no SQL leaks above repo).
- `bun test tests/memory-service.test.ts` — green.
- `bun test` — без regression (838/0).

## Приёмка

1. `bun run scripts/check-file-size.ts` — split ≤150, transitional удалена.
2. `bun run scripts/check-deep-imports.ts` — green.
3. `bunx tsc --noEmit` — clean.
4. `bun test tests/repo-rules.test.ts` — 5/5.
5. `bun test` — 838/0 baseline.
6. `bun test tests/layer-boundary.test.ts` — green.

## Constraints

- Scope-lock: только файлы в §Файлы.
- Public API: `MemoryRepository` class methods unchanged.
- Layer-boundary: repo NEVER imports from `services/*`, `pipeline/*`, `routes/*`.
- Не меняем `db/tables/memory|shared` (это W3-3/W3-4).
