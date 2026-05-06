# Task 03 — Tasks & Projects (`C-tasks-and-projects.html`)

## Read first

- [`../00-master-spec.md`](../00-master-spec.md), [`./00-foundation.md`](./00-foundation.md)

## Goal

Mock центральной страницы задач: 4 таба, 2 пула, отдельный registry проектов, авто-трекер. Это самая важная функциональная страница после чата согласно резолюциям юзера.

Output: `docs/design/p7-mockups/C-tasks-and-projects.html` (≤600 строк HTML).

## Layout

**Header (sticky):**

- Page title "Задачи"
- Auto-tracker widget справа (desktop) — компактный: название текущей running задачи + elapsed time + stop button. Если ничего не tracked: "Нет активного таймера" в tertiary text.
- На mobile: header с back-arrow + title; auto-tracker перенесён в persistent footer (sticky bottom, full-width).

**Stat bar** под header:
- 5 metric chips: "Запланировано N", "Выполнено M", "In progress K", "Overdue X", "Time today H ч"
- Минималистичные, fs-sm, secondary text для labels, primary для значений.

**Tab navigation:**
- 4 таба: «Актуальные» / «Для агентов» / «Мои» / «Проекты»
- Как в shared/components.css `.tabs__trigger`
- Url fragment sync: `#actual`, `#agents`, `#mine`, `#projects`

**Quick-add button:**
- Desktop: кнопка [+ Новая задача] в right corner header или sticky bottom-right floating.
- Mobile: FAB (Floating Action Button) bottom-right.
- Click → opens quick-add modal.

## Tab 1 — «Актуальные»

Cross-pool top-of-mind. Объединённый view.

- Список задач, упорядочен:
  1. Overdue (status active, due_at < now) — sorted by due_at ASC
  2. Due today
  3. In progress (status='in_progress')
  4. Due this week
- Каждая строка:
  - Status check-circle (click toggles done)
  - Title (medium weight)
  - Priority indicator (3-cell ladder: low/med/high)
  - Pool badge: либо «agent» (с scope: autonomous/free-agent/freelance/tg) либо имя проекта (если project_id), либо «без проекта»
  - Due_at (relative + цвет: red если overdue, warn если today, neutral иначе)
  - Time tracked (если был timer): "1ч 23м"
  - Меню (...): edit, archive, delete, [Запустить таймер] / [Остановить]
- Hover: row становится actionable, показывает quick-actions
- Mobile: 1-column, tap row → expand inline (description, full meta), swipe-right marks done

**Empty state:** "Нет актуальных задач — отдохни 🪷"

## Tab 2 — «Для агентов» (Pool 1)

Задачи с scope ≠ default: autonomous / free-agent / freelance / tg.

- Группировка по scope (collapsible sections)
- Каждая section: header "🤖 Autonomous (5)" → expandable
- Список задач внутри: tot же row format что в «Актуальные», но без pool badge (scope понятен по группе)
- Quick-add сверху: [+ Новая задача для агента ▼] с scope-selector (radio: autonomous / free-agent / freelance / tg)
- Filter bar: status (active/done/all), agent_id (if applicable)
- На каждой строке кнопка [Передать активному агенту] (если в pool есть подходящий) → opens confirm-modal

**Empty state:** "Агенты пока ничего не делают. Запусти scheduler в [B Делегирование]"

## Tab 3 — «Мои» (Pool 2)

Личные задачи, group-by project.

**Project selector** сверху:
- Dropdown: «Все мои» / «Без проекта» / project1, project2, ...
- Default: «Все мои» — flat list с project-badge на каждой row
- Selected project — flat list только этого project + заголовок с info (deadline, прогресс), action buttons [Edit project] [Archive]

**List:**
- Sort options chip-row: priority / due_at / created_at / alphabet
- Каждая row: status-circle, title, priority, due_at, time-tracked
- Inline edit на double-click (title, priority через select)
- Drag-handle слева для re-order priority (только в одной project view)
- Кнопка [+] для quick-add внутри текущего проекта (без modal)

**Empty state:**
- «Без проекта» selected: "Все мои задачи привязаны к проектам. Создай задачу без привязки →"
- Конкретный project: "В этом проекте пока нет задач. [+ Добавить] →"

## Tab 4 — «Проекты»

Registry проектов.

- Top: filter pills (Active / Archived / Completed)
- Search input
- Кнопка [+ Новый проект] справа

**Project cards** (desktop: grid 2-3 columns; mobile: stack):
- Title (semibold lg)
- Description (2-line truncated)
- Status badge (active/archived/completed)
- Stats: "5 активных • 12 всего • 67% готово"
- Progress bar (accent fill)
- Deadline (если есть): "до 15 мая" или "просрочено 3 дня"
- Color accent strip (если color override)
- Hover: shadow-md
- Click → drill-in: переход в Tab «Мои» с selected project

**Project detail drill-in** (либо separate URL fragment либо modal):
- Header с editable title, description, кнопка [Edit] [Archive] [Delete]
- Stats panel
- Tasks list (из этого проекта)
- Создание задачи inline через quick-add внизу

**Empty state:** "Нет проектов. [+ Создать первый] →"

## Quick-add modal (универсальный)

Триггер: FAB / [+] кнопка / Cmd-K → "New task"

- Title input (autofocus)
- Description textarea (optional, expandable)
- **Pool selector** (radio): «Для агентов» / «Мои»
  - Если «Для агентов» → дополнительно scope dropdown
  - Если «Мои» → дополнительно project dropdown (с опцией «без проекта»)
- Priority slider (0-10, default 5)
- Due_at — date picker с smart presets ("Сегодня", "Завтра", "Эта неделя", "Custom...")
- Recurring (optional collapse): preset radio (никогда / каждый день / каждая неделя / каждый месяц) + placeholder для custom cron
- [Pin для auto-track] checkbox
- [Cancel] [Создать] buttons

Если открыт через Cmd-K с pre-filled context (например из чата "поставь задачу на пятницу"):
- Title pre-filled с распознанным текстом
- Due_at pre-set "пятница"
- Toast после создания: "Задача создана • [View]"

## Auto-tracker

**Header widget (desktop):**
- Если running: "▶ Реализация P7 mockups • 1ч 23м [⏹]"
- Если idle: "Нет активного таймера" (tertiary text)
- Click на title → ведёт в задачу

**Mobile footer (sticky bottom, full-width):**
- Те же данные, padding-y 12px
- Hide если scrolling вниз (revealed на scroll-up)

**Full panel в Tab 1 «Актуальные»** (только desktop, sidebar справа):
- Section "Сегодня в работе"
- Current running timer карточка
- Timer history за сегодня: список таймеров (task title + start_at + duration + stop reason)
- "Total time today: 4ч 17м"
- Pinned tasks list ниже: задачи с `pinned_for_tracking=true` — показывает auto-status (running/idle если pinned active task)

**На любой row task:**
- Кнопки [▶ Старт] / [⏹ Стоп] (icon-button)
- Pin toggle [📌] (small icon, accent fill если pinned)
- Если pinned + done → toast "Auto-tracker stopped" (так как pin клиренится при done)

## Mock data needed

- `tasks` (30+ tasks: 12 with scope=default, 18 with various agent scopes)
- `projects` (5 projects: 3 active, 1 archived, 1 completed)
- `taskTimers` (current running timer + 8-10 history entries за today)
- 4-5 tasks помечены `pinned_for_tracking: true`
- Tasks с разной recurring_pattern (mix daily/weekly/null)

## Components чек-лист

- [ ] Sticky header с page title + auto-tracker widget
- [ ] Stat bar с 5 metric chips
- [ ] Tab navigation (4 tabs) с url-fragment sync
- [ ] Tab 1: cross-pool sorted list с overdue/today/in_progress sections
- [ ] Tab 2: collapsible groups by scope, scope-aware quick-add
- [ ] Tab 3: project selector + flat list, inline edit, drag-reorder
- [ ] Tab 4: project cards grid + drill-in detail
- [ ] FAB button (mobile) / inline quick-add button (desktop)
- [ ] Quick-add modal со всеми полями (pool selector, project dropdown, recurring, pin)
- [ ] Auto-tracker header widget (desktop)
- [ ] Auto-tracker footer widget (mobile, hide-on-scroll)
- [ ] Full timer panel в Tab 1 (desktop only)
- [ ] Pin/Unpin toggle на каждой row
- [ ] Start/Stop timer buttons на каждой row
- [ ] Empty states для всех 4 табов

## Acceptance criteria

- [ ] HTML ≤600 строк
- [ ] All 4 tabs работают, url fragment правильно switches
- [ ] Quick-add modal opens из FAB и заполняет правильный default scope/project в зависимости от current tab
- [ ] Auto-tracker widget живой: тикает каждую секунду (через setInterval), [⏹] останавливает
- [ ] Mobile (375px): hamburger открывает sidebar, FAB достижим thumb-tap, footer-tracker visible
- [ ] Desktop (1280px): right panel в Tab 1 с full timer panel показывается одновременно с list
- [ ] Done-toggle через check-circle: row fades + moves to "completed today" section
- [ ] Pin toggle: visual confirm + toast "Авто-трекер запущен" если pinned + active
- [ ] Empty states действительно появляются если фильтр исключает все строки
- [ ] Drag-reorder в Tab 3 (single project view) работает (HTML5 drag-drop API)

## Notes

- Auto-tracker state в памяти браузера (window-scoped). Refresh страницы не сохраняет (мок).
- Drag-reorder: vanilla HTML5 DnD API, без library.
- Date picker: native `<input type="date">` для simplicity. Smart presets — chips сверху которые pre-fill.
- Recurring custom-cron — placeholder с "advanced — будет в v2", input disabled.
- Inline edit: contenteditable + blur listener saves в mock state. Просто visual demo.
- Mobile swipe-to-done: HTML touch events, swipe-right на row → fade-out + move to completed (in-memory).
