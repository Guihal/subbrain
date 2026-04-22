# Phase 6 — Web UI `/tasks`

**Complexity:** standard. **Estimate:** 1 day.
**Depends on:** Phase 1 (REST /v1/tasks готов). Phase 5 опционально (history tab покажет digests).
**Trigger:** `/task --depth=standard <весь этот файл как prompt>`.

## Цель

Добавить страницу `/tasks` в web UI subbrain для ручного управления. Юзер должен видеть все свои задачи, фильтровать по scope/status, создавать/редактировать/закрывать через клики, смотреть historical digests.

## Контекст

**REST API (готов, Phase 1):**
- `GET /v1/tasks?scope=&status=&limit=&offset=&page=&page_size=` → `PaginatedResponse<TaskRow>`.
- `POST /v1/tasks` body `{title, description?, scope?, priority?, due_at?}` → `TaskRow`. Source="user" автоматически.
- `GET /v1/tasks/:id` → `TaskRow | 404`.
- `PATCH /v1/tasks/:id` body `{title?, description?, priority?, due_at?, status?}`. Status transitions валидируются, 409 на invalid_transition.
- `DELETE /v1/tasks/:id` → `{ok:true}`.
- `GET /v1/tasks/history?scope=&since=&limit=&offset=` → `PaginatedResponse<TaskRow>` (+ digests после Phase 5).

**Envelope:** `{items, total, page, page_size}`. 404: `{error:{message}}`.
**Auth:** `authMiddleware` — требуется `Authorization: Bearer <token>`. `useApi()` composable уже есть и инжектит токен автоматически.
**Existing UI patterns:** `web/app/pages/memory.vue`, `web/app/pages/freelance.vue` — следовать паттерну (6-tab для memory, filter+table для freelance).

## Scope

### 1. Composable `web/app/composables/useTasks.ts`

По аналогии с `useMemory.ts`, `useFreelance.ts`. Минимум:

```ts
export function useTasks() {
  const tasks = useState<TaskRow[]>("tasks.items", () => []);
  const total = useState<number>("tasks.total", () => 0);
  const loading = useState<boolean>("tasks.loading", () => false);
  const filters = useState<TaskFilters>("tasks.filters", () => ({
    scope: undefined,
    status: "active",
    page: 1,
    page_size: 20,
    q: "",
  }));

  const { api } = useApi();

  async function refresh(): Promise<void> { /* GET /v1/tasks + apply filters */ }
  async function create(body: CreateBody): Promise<TaskRow> { /* POST */ }
  async function update(id: string, patch: PatchBody): Promise<TaskRow> { /* PATCH */ }
  async function remove(id: string): Promise<void> { /* DELETE */ }
  async function done(id: string, summary?: string): Promise<TaskRow> { /* PATCH status=done, description append */ }
  async function cancel(id: string, reason?: string): Promise<TaskRow> { /* PATCH status=cancelled */ }
  async function start(id: string): Promise<TaskRow> { /* PATCH status=in_progress */ }

  async function history(scope?: TaskScope, since?: number): Promise<{items: TaskRow[]; total: number}> {
    /* GET /v1/tasks/history */
  }

  return { tasks, total, loading, filters, refresh, create, update, remove, done, cancel, start, history };
}
```

### 2. Components

**`web/app/components/TaskRow.vue`** — одна строка таблицы:
- Scope badge (color-coded: global=gray, autonomous=blue, free-agent=purple, freelance=orange, tg=teal).
- Status icon (⏳ / 📌 / ✅ / ❌).
- Title (truncate 120).
- Priority chip (p0 скрыт, p1-3 серый, p4-7 жёлтый, p8-10 красный).
- Due date (формат YYYY-MM-DD MSK). Overdue (due_at < now && !terminal) → красная рамка.
- Updated_at (relative time "2h ago").
- Action buttons (иконки):
  - ✅ Done (prompt "Краткое summary (опц)"), calls `done(id, summary)`.
  - ❌ Cancel (prompt "Причина (опц)"), calls `cancel(id, reason)`.
  - ✏️ Edit → открывает edit modal.
  - 🗑 Delete → confirm dialog.
  - ▶️ Start (только если status=open) → `start(id)`.

**`web/app/components/TaskFormModal.vue`** — создать/редактировать:
- Fields: `title` (required, max 200), `scope` (select из 5), `priority` (slider 0-10), `due_at` (datepicker, MSK, converts to unix seconds), `description` (textarea).
- Props: `modelValue: boolean` (open state), `task?: TaskRow` (edit mode when passed).
- Submit → create или update depending on mode.

### 3. Page `web/app/pages/tasks.vue`

Layout:
- Header: "Задачи" title + search input (filters.q) + `+ Новая` button (opens modal).
- Filters row:
  - Scope multi-select checkboxes (global/autonomous/free-agent/freelance/tg) — controls filters.scope.
  - Status chips: Open / InProgress / Done / Cancelled / **All** (active по дефолту = open+in_progress).
- Tabs: "Активные" (filters.status='active'), "История" (loads `/history`).
- Table:
  - Columns: scope, status, title, priority, due_at, updated_at, actions.
  - Rows через v-for с `<TaskRow :task="t" @update="handleUpdate" />`.
  - Pagination footer (prev/next buttons, "Page X of Y").
- Overdue highlighting: `v-if="isOverdue(t)"` → class `border-l-4 border-red-500`.
- Empty state: "Нет задач. Создай через `+ Новая`".
- Loading skeleton.

### 4. Sidebar link

Добавить в `web/app/layouts/default.vue` (или аналог) NuxtLink `/tasks` иконка 📋 "Задачи". Между "🧠 Память" и "💰 Фриланс" или по смыслу.

### 5. Tests

**`web/app/pages/tasks.test.ts`** или `tests/e2e/tasks.test.ts` (если есть e2e) — Vitest + happy-dom или playwright:
- Render tasks list.
- Filter by scope → API call with scope param.
- Create task → POST + refresh + appears in list.
- Done button → PATCH status + row moves to "История" tab.
- Edit modal → update.
- Delete confirms → DELETE + row removes.
- Overdue highlight when due_at < now && status='open'.

(Если нет frontend test setup — ограничиться typecheck + manual smoke.)

### 6. API types

**`web/app/types/task.ts`** (new или re-use shared types):

```ts
export type TaskScope = "global" | "autonomous" | "free-agent" | "freelance" | "tg";
export type TaskStatus = "open" | "in_progress" | "done" | "cancelled";

export interface TaskRow {
  id: string;
  title: string;
  description: string;
  scope: TaskScope;
  status: TaskStatus;
  priority: number;
  due_at: number | null;
  source: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}
```

Если backend types уже expose'd через shared package — import. Иначе duplicate.

## Edge cases

- Large description в edit modal → textarea max-rows, scroll.
- Datepicker timezone: UI вводит в MSK, converts to `Math.floor(picked.getTime() / 1000)` для backend (seconds UTC). Display: `new Date(due_at * 1000).toLocaleDateString("ru-RU", { timeZone: "Europe/Moscow" })`.
- Concurrent edit (backend & UI): после PATCH refresh всю страницу (не optimistic update всей row) чтобы увидеть timestamp/status updates.
- Priority=0 omitted in display (нет chip) — чтобы не шумел визуально.
- Scope filter "all" = undefined в API (not sent). Status filter "active" = "active" в API. Status "all" = undefined.

## Verify

```bash
# Frontend typecheck:
cd web && bunx nuxi typecheck

# Dev server:
cd web && bun run dev
# Открой http://localhost:3000/tasks — кликни по всему, проверь CRUD, фильтры, Overdue.

# Backend не трогается — ничего не ломается в `bun test` (главный repo).
```

**Production smoke:** после deploy (manual) — открой `https://<prod>/tasks`, создай/закрой задачу, проверь что обновляется без reload.

## Out of scope

- Drag-and-drop приоритизация.
- Batch actions (select multiple → done/cancel).
- Real-time updates через SSE/WS (polling достаточно для ручного flow).
- Mobile responsive design beyond baseline.
- Keyboard shortcuts для quick done/cancel.

## Guardrails reminder

- `web/app/pages/tasks.vue` ≤ 250 lines (если upstream exceeds — вынеси части в sub-components).
- `useApi()` composable — правильный путь для API calls (инжектит Bearer).
- TypeScript strict — никаких `as any`.
- UI strings RU, code/типы EN.

## Что изменяется в git

Новые: `web/app/pages/tasks.vue`, `web/app/composables/useTasks.ts`, `web/app/components/TaskRow.vue`, `web/app/components/TaskFormModal.vue`, `web/app/types/task.ts` (или re-use).
Modified: `web/app/layouts/default.vue` (sidebar link).

## Сразу после

Запустить `/caveman:compress docs/tasks/task-store/` если хочется ужать доки. Или закрыть серию — `Dashboard.md` в вальте покажет "Task Store: 6/6 done".
