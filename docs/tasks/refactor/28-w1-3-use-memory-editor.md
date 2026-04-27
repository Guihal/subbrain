# 28-W1-3 — split `useMemoryEditor.ts` (201 → ≤150)

**Status:** OPEN. Master: [28-file-size-150-limit.md](28-file-size-150-limit.md) Wave 1.

## Цель

Разбить `web/app/composables/useMemoryEditor.ts` (201 LOC) на split-folder. Public API сохранить — `useMemoryEditor(selected) → {...toRefs(fields), dirty, markDirty, resetFrom, buildPatch, fmtTs, badgeColor, rowBadge}`.

## Файлы

**Удалить** (после переноса):
- `web/app/composables/useMemoryEditor.ts`

**Создать**:
- `web/app/composables/useMemoryEditor/index.ts` — composable orchestrator (≤80 LOC); reactive `fields` + `dirty` ref + `watch(selected, resetFrom)` + return composition.
- `web/app/composables/useMemoryEditor/patches.ts` — типы (`FocusPatch`, `SharedPatch`, `ContextPatch`, `ArchivePatch`, `AgentPatch`, `EditorPatch`) + `resetFrom(fields, row)` + `buildPatch(fields, row)` (pure functions).
- `web/app/composables/useMemoryEditor/format.ts` — `fmtTs(ts)`, `badgeColor(row)`, `rowBadge(row)` (pure formatters).

**Trigger transitional whitelist removal**: `scripts/check-file-size.ts` строка `"web/app/composables/useMemoryEditor.ts": 202` → удалить.

## Изменение

1. `index.ts` объявляет state (reactive `fields`, `dirty` ref), импортирует pure-функции из `patches.ts`/`format.ts`, оборачивает их в closure'ы, возвращающие готовые refs.
2. `patches.ts` экспортирует pure-функции, принимающие `fields` и `row` параметрами (без замыканий).
3. `format.ts` — три pure-функции, никакого state.
4. Сохранить inline-комментарии (M-12 mig 15 confidence note, "HIGH"-equivalent badge note).
5. Auto-import: `useMemoryEditor()` остаётся вызываемым из `pages/memory.vue` через Nuxt auto-import на `composables/useMemoryEditor/index.ts`.
6. Backward-compat type re-export: типы (`EditorPatch` etc) экспортируются из `index.ts` как `export type { EditorPatch } from "./patches"` — потому что внешние импорты могут идти через `~/composables/useMemoryEditor` без сегмента path.

## Тесты

Нет существующих unit-тестов. Manual smoke: `/memory` page — выбрать row любого слоя, отредактировать, save → проверить, что patch правильный + badge цвет корректный.

## Приёмка

Из repo root, exit 0:

1. `bun run scripts/check-file-size.ts` — все split-файлы ≤150, transitional entry удалена.
2. `bun run scripts/check-deep-imports.ts` — без новых нарушений.
3. `bunx tsc --noEmit` — без regressions.
4. `bun test tests/repo-rules.test.ts` — все 5 зелёные.
5. `bun test` — без новых failed (baseline 838 pass / 0 fail).
6. `grep -rn 'useMemoryEditor' web/app/`: импорты не deep-import'ят split-internals (используют либо auto-import, либо `~/composables/useMemoryEditor`).

## Constraints

- **Scope-lock**: только файлы в §Файлы. Не редактировать `useMemory.ts`, `pages/memory.vue`, других consumers.
- Public API стабилен (8 returned значений + spread of `toRefs(fields)`).
- Типы `EditorPatch`/`FocusPatch`/etc остаются экспортируемыми через `useMemoryEditor` импорт-путь.
