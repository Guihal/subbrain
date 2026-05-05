# 28-W2-4 — split `night-cycle/prune/stray-tasks.ts` (164 → ≤150)

**Status:** OPEN. Master: [28-file-size-150-limit.md](28-file-size-150-limit.md) Wave 2.

## Цель

Разбить `packages/agent/src/pipeline/night-cycle/prune/stray-tasks.ts` (164 LOC) на split-folder. Public API сохранить — `collectStrayTasks(memory, router)` + `LAST_RUN_FOCUS_KEY`.

Также убрать deep-import barrel violation: `tasks-classify.ts` импортируется напрямую (`./tasks-classify`); после split → re-export через parent `prune/index.ts` снимет TRANSITIONAL_DEEP_IMPORTS entry.

## Файлы

**Удалить** (после переноса):
- `packages/agent/src/pipeline/night-cycle/prune/stray-tasks.ts`

**Создать**:
- `packages/agent/src/pipeline/night-cycle/prune/stray-tasks/index.ts` — orchestrator (≤80 LOC). `collectStrayTasks` экспортирует, читает focus key, вызывает `fetchCandidates` → `classifyAndUpsert` → советует `setFocus`.
- `packages/agent/src/pipeline/night-cycle/prune/stray-tasks/fetch.ts` — `fetchCandidates(memory, windowStart): CandidateRow[]` — query `shared_memory` + `layer2_context` queries, объединяет в `CandidateRow[]`. Содержит `SharedScanRow`/`ContextScanRow` interfaces.
- `packages/agent/src/pipeline/night-cycle/prune/stray-tasks/classify.ts` — `classifyAndUpsert(memory, router, candidates, deadline)` — per-row loop с MAX_PER_CYCLE / MAX_DURATION_MS бюджетом. Использует `classifyCandidate` из `./tasks-classify`. Возвращает counter migrated.
- `packages/agent/src/pipeline/night-cycle/prune/stray-tasks/constants.ts` — `LAST_RUN_FOCUS_KEY`, `MAX_WINDOW_SECONDS`, `MAX_PER_CYCLE`, `MAX_DURATION_MS`. Re-export `LAST_RUN_FOCUS_KEY` через `index.ts` для backward-compat (есть consumer'ы).

**Изменить**:
- `packages/agent/src/pipeline/night-cycle/prune/index.ts` — добавить `export { collectStrayTasks, LAST_RUN_FOCUS_KEY } from "./stray-tasks"` если ещё нет; добавить `export { classifyCandidate, ... } from "./tasks-classify"` чтобы убрать deep-import нарушение.
- `scripts/check-deep-imports.ts` `TRANSITIONAL_DEEP_IMPORTS` Set — удалить `stray-tasks/tasks-classify` если есть; снять deep-import ограничение для prune/tasks-classify.

**Trigger**: `scripts/check-file-size.ts` `"packages/agent/src/pipeline/night-cycle/prune/stray-tasks.ts": 165` → удалить.

## Изменение

1. Перенести функции с пословным сохранением логики (никаких изменений семантики).
2. Constants → `constants.ts`. Interfaces (`SharedScanRow`/`ContextScanRow`) — в `fetch.ts` (там они используются).
3. Idempotency / focus-key advance логика в `index.ts`: если loop throws — focus key не двигается; если success — `setFocus(LAST_RUN_FOCUS_KEY, String(now))`.
4. JSDoc top-of-file (Step 12 описание + Window state-track + idempotent migrate via upsertTaskBySource) — на `index.ts`.
5. Сохранить `logger.child("night.stray")` в `index.ts`.
6. Consumers: `grep -rn 'stray-tasks' src/`. Найти `night-cycle/index.ts` или scheduler — поправить если path сменился (ожидаем, что barrel `prune/index.ts` уже re-exports).
7. `prune/index.ts` барлет — также re-export `tasks-classify` symbols (`classifyCandidate`, `hasBlacklistTag`, `hasCompletedStatusTag`, `hasTaskTag`, types) — устранит deep-import предупреждение.
8. После шага 7 удалить запись `tasks-classify.ts` из `TRANSITIONAL_DEEP_IMPORTS` в `scripts/check-deep-imports.ts`.

## Тесты

- `bun test tests/night-cycle*.test.ts` — green (если есть; если нет — тест на step12 логику или не существует).
- `bun test` — баselineline 838/0.

## Приёмка

Из repo root, exit 0:

1. `bun run scripts/check-file-size.ts` — все split-файлы ≤150, transitional entry удалена.
2. `bun run scripts/check-deep-imports.ts` — без regression. TRANSITIONAL Set уменьшился (tasks-classify entry удалена).
3. `bunx tsc --noEmit` — clean.
4. `bun test tests/repo-rules.test.ts` — 5/5.
5. `bun test` — без новых failed.
6. `grep -rn 'collectStrayTasks\|LAST_RUN_FOCUS_KEY' src/` — все consumers резолвят через `~/pipeline/night-cycle/prune` (или `./prune` относительный).

## Constraints

- Scope-lock: только файлы в §Файлы.
- Public API стабилен: `collectStrayTasks(memory, router): Promise<number>` + `LAST_RUN_FOCUS_KEY` const string.
- Никаких изменений в `tasks-classify.ts` логике (только re-export через parent index).
- Idempotency сохраняется: focus-key advance только на success.
