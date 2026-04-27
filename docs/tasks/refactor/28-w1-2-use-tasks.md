# 28-W1-2 — split `useTasks.ts` (167 → ≤150)

**Status:** OPEN. Master: [28-file-size-150-limit.md](28-file-size-150-limit.md) Wave 1.

## Цель

Разбить `web/app/composables/useTasks.ts` (167 LOC) на split-folder. Public API сохранить — `useTasks() → {items, visibleItems, total, loading, error, filters, refresh, create, update, remove, start, done, cancel, history, setFilter, resetPage}`.

## Файлы

**Удалить** (после переноса):
- `web/app/composables/useTasks.ts`

**Создать**:
- `web/app/composables/useTasks/index.ts` — composable orchestrator (≤80 LOC); useState declarations + сборка return; делегация в submodules.
- `web/app/composables/useTasks/api.ts` — `refresh`, `create`, `update`, `remove`, `start`, `done`, `cancel`, `history` + helpers `buildParams`, `captureError`. Принимает state refs + filters ref + api() как параметры.
- `web/app/composables/useTasks/filters.ts` — `setFilter`, `resetPage`, `visibleItems` (computed). Принимает filters ref + items ref.

**Trigger transitional whitelist removal**: `scripts/check-file-size.ts` строка `"web/app/composables/useTasks.ts": 168` (drift 167→168 в snapshot, см. master) → удалить.

## Изменение

1. State (`items`, `total`, `loading`, `error`, `filters`) объявляется в `index.ts` через `useState(...)`.
2. `api.ts` экспортирует функции, принимающие refs + `useApi()` (передаётся из index).
3. `filters.ts` экспортирует функции/computed, принимающие refs.
4. Никаких изменений семантики — пословный перенос.
5. Сохранить JSDoc-комментарии (особенно тот про "Mutations do NOT auto-reload" в api.ts и про "setFilter mutates state ONLY" в filters.ts).
6. Auto-import: после split, `useTasks()` остаётся вызываемым из `pages/tasks.vue` без изменений (Nuxt подцепит `composables/useTasks/index.ts`).

## Тесты

Нет существующих unit-тестов. Manual smoke (NOT requirement): `/tasks` page — refresh, create, edit, mark done, история, поиск/фильтр.

## Приёмка

Из repo root, exit 0:

1. `bun run scripts/check-file-size.ts` — все split-файлы ≤150, transitional entry удалена.
2. `bun run scripts/check-deep-imports.ts` — без новых нарушений.
3. `bunx tsc --noEmit` — без regressions.
4. `bun test tests/repo-rules.test.ts` — все 5 зелёные.
5. `bun test` — без новых failed (baseline 838 pass / 0 fail).
6. `grep -rn 'useTasks' web/app/pages web/app/components`: импортируется как Nuxt auto-import без явных deep-import statements.

## Constraints

- **Scope-lock**: только файлы в §Файлы. Не редактировать `pages/tasks.vue`, `types/task.ts`, других composables.
- Public API стабилен (16 returned значений неизменны по имени и типу).
