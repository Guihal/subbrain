# 28-W1-5 — split `pages/tasks.vue` (245 → ≤150)

**Status:** OPEN. Master: [28-file-size-150-limit.md](28-file-size-150-limit.md) Wave 1.

## Цель

Уменьшить `web/app/pages/tasks.vue` с 245 LOC до ≤150 (Vue SFC cap = total `<template>+<script>+<style>`). Вынести toolbar + footer pagination в child-компоненты + page-specific логику в composable.

## Файлы

**Изменить**:
- `web/app/pages/tasks.vue` — оставить только thin orchestrator: script setup делегирует в `useTasksPage()`, template = composition существующих + новых child компонентов. Целевой LOC ≤150.

**Создать**:
- `web/app/components/tasks/TasksToolbar.vue` — header bar (sidebar toggle + "📋 Задачи" + search input + "Новая" button). Props: searchQuery (v-model для двусторонней привязки через `:model-value` + `@update:model-value`) ИЛИ raw value + emit `update:search`, sidebarOpen (v-model). Emit: openNew.
- `web/app/components/tasks/TasksFooter.vue` — pagination footer (← page X / Y → + loading indicator + "Поиск по странице" hint когда hasQ). Props: hasQ, visibleCount, totalCount, page, pageCount, loading. Emit: prev, next.
- `web/app/composables/useTasksPage.ts` — page-local state (`historyItems`, `historyTotal`, `showForm`, `editingTask`, `confirmDelete`, `confirmCancel`, `mode`, `sidebarOpen`) + computed (`showDelete`, `showCancel`, `hasQ`, `pageCount`) + handlers (`loadHistory`, `dispatch`, `wrap`, `switchMode`, `toggleScope`, `openNew`, `openEdit`, `onSubmit`, `doDelete`, `doCancel`, `handleStart`, `handleDone`) + lifecycle (`onMounted`, `watch`). Возвращает всё page-specific API.

**Сохранить** (уже существуют, не трогать):
- `TaskFilterBar`, `TaskListBody`, `TaskFormModal`, `TaskConfirmModal` — без изменений.
- `useTasks()` — без изменений.

## Изменение

1. Перенести **весь** `<script setup>` (кроме импортов типов + одной строки `const page = useTasksPage()`) → `useTasksPage.ts`. Composable импортирует `useTasks()` внутри + `useState("sidebar-open"...)` + `useState("tasks.mode"...)`.
2. Перенести `<header>` блок (lines ~136-156) → `TasksToolbar.vue`. Props: `searchQuery: string`, `sidebarOpen: boolean`. Emits: `update:searchQuery`, `update:sidebarOpen`, `openNew`.
3. Перенести `<footer>` блок (lines ~189-218) → `TasksFooter.vue`. Props: `hasQ`, `visibleCount`, `totalItemsCount`, `page`, `pageCount`, `loading`. Emits: `prev`, `next`.
4. `pages/tasks.vue` template = `<TasksToolbar />` + `<TaskFilterBar />` + error banner div + `<TaskListBody />` + `<TasksFooter />` + 3× modal (TaskFormModal + 2× TaskConfirmModal). Все привязки через `page.*`.
5. Vue auto-import работает для `~/components/tasks/*` через Nuxt convention.
6. Сохранить existing inline-комментарии (про watch dispatcher, mode persistence, error swallowing).
7. Все handler signatures + emit names + watch wiring семантически идентичны.

**Trigger transitional whitelist removal**: `scripts/check-file-size.ts` строка `"web/app/pages/tasks.vue": 246` → удалить.

## Тесты

Нет существующих unit-тестов. Manual smoke: `/tasks` page — оба mode (active/history); create/edit/delete/cancel/start/done; search filter; pagination; sidebar toggle на мобильном.

## Приёмка

Из repo root, exit 0:

1. `bun run scripts/check-file-size.ts` — все split-файлы ≤150 (tasks.vue + child .vue + composable), transitional entry удалена.
2. `bun run scripts/check-deep-imports.ts` — без новых нарушений.
3. `bunx tsc --noEmit` — без regressions.
4. `bun test tests/repo-rules.test.ts` — все 5 зелёные.
5. `bun test` — без новых failed (baseline 838 pass / 0 fail).
6. `wc -l web/app/pages/tasks.vue` ≤ 150.

## Constraints

- **Scope-lock**: только файлы в §Файлы. Не редактировать `useTasks.ts`, `types/task.ts`, `TaskFilterBar.vue`, `TaskListBody.vue`, `TaskFormModal.vue`, `TaskConfirmModal.vue`.
- Public behavior identical: каждая click/save/delete/cancel/start/done/search/paginate операция должна работать как до split.
- Никаких новых пакетов / новых composables за пределами `useTasksPage`.
