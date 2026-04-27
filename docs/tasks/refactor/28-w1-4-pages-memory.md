# 28-W1-4 — split `pages/memory.vue` (248 → ≤150)

**Status:** OPEN. Master: [28-file-size-150-limit.md](28-file-size-150-limit.md) Wave 1.

## Цель

Уменьшить `web/app/pages/memory.vue` с 248 LOC до ≤150 (Vue SFC cap = total `<template>+<script>+<style>`). Вынести toolbar (header + tabs + filter rows) и delete-modal в child-компоненты + page-specific логику в composable.

## Файлы

**Изменить**:
- `web/app/pages/memory.vue` — оставить только thin orchestrator: script setup использует composables, template renders main content + child components. Целевой LOC ≤150.

**Создать**:
- `web/app/components/memory/MemoryToolbar.vue` — header bar (sidebar toggle + "🧠 Память" title + загрузка count) + tab nav (MemoryTabs + Pending button + count badge) + filter rows (pending layer dropdown + shared kind dropdown) + MemoryFilterBar wrapping. Принимает props: activeTab, totalForActive, loading, pendingCount, pendingLayer (v-model), kindFilter (v-model), search/agentFilter/agentIds/logSessionFilter/logSessions/page/pageCount, sidebarOpen (v-model). Emit: switchTab, submit-search.
- `web/app/components/memory/MemoryDeleteModal.vue` — UModal для подтверждения удаления. Props: row (MemoryRow | null). Emit: cancel, confirm.
- `web/app/composables/useMemoryPage.ts` — page-local state (`confirmDelete`, `showDelete`, `pageCount`) + `onSearchSubmit`, `handleDelete(row)` + watch wiring (`watch([page, agentFilter, ...], loadActive)`). Принимает `useMemory()`-objект и возвращает page-specific helpers.

**Сохранить**:
- Все existing references (`useMemory()`, `MemoryTabs`, `MemoryFilterBar`, `MemoryList`, `MemoryRow`, `MemoryEditor`) — без переименований.

## Изменение

1. Перенести script section's `confirmDelete`, `showDelete`, `pageCount`, `onSearchSubmit`, `handleDelete`, watch → `useMemoryPage(memory)`.
2. Перенести template's header + tabs row + pending filter + shared kind filter + MemoryFilterBar → `MemoryToolbar.vue`.
3. Перенести UModal → `MemoryDeleteModal.vue`.
4. `pages/memory.vue` template = `<MemoryToolbar :props="..." />` + main content area (existing pending/list/editor block) + `<MemoryDeleteModal :row="confirmDelete" @cancel="..." @confirm="handleDelete" />`.
5. Vue auto-import работает для `~/components/memory/*` через Nuxt convention (`MemoryToolbar`, `MemoryDeleteModal` доступны в template без import statements).
6. Сохранить все props/emit names + handler signatures (saveFocus, deleteShared, approveMemory, rejectMemory etc) — это API не меняется.

**Trigger transitional whitelist removal**: `scripts/check-file-size.ts` строка `"web/app/pages/memory.vue": 249` → удалить.

## Тесты

Нет существующих unit-тестов. Manual smoke: `/memory` page — все 6 tabs (focus/shared/context/archive/agent/log/pending) работают; редактирование/удаление/создание не сломано; search/filter/pagination функционируют.

## Приёмка

Из repo root, exit 0:

1. `bun run scripts/check-file-size.ts` — все split-файлы ≤150 (memory.vue + child .vue + composable), transitional entry удалена.
2. `bun run scripts/check-deep-imports.ts` — без новых нарушений.
3. `bunx tsc --noEmit` — без regressions.
4. `bun test tests/repo-rules.test.ts` — все 5 зелёные.
5. `bun test` — без новых failed (baseline 838 pass / 0 fail).
6. `wc -l web/app/pages/memory.vue` ≤ 150.

## Constraints

- **Scope-lock**: только файлы в §Файлы. Не редактировать `useMemory.ts`, `useMemoryEditor.ts`, `MemoryEditor.vue`, `MemoryList.vue`, `MemoryFilterBar.vue`, `MemoryRow.vue`, `MemoryTabs.vue` (existing components).
- Public behavior identical: каждая click/save/delete/approve операция должна работать как до split.
- Никаких новых пакетов / новых composables за пределами `useMemoryPage`.
