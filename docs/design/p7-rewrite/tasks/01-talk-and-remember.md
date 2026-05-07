# Task 01 — Talk & Remember (`A-talk-and-remember.html`)

## Read first

- [`../00-master-spec.md`](../00-master-spec.md) — общие constraints, эстетика, cross-cutting
- [`./00-foundation.md`](./00-foundation.md) — design system, tokens, components (должны быть готовы)

## Goal

Mock главной функциональной страницы — разговор плюс встроенный доступ к памяти. Это центральный экран, через который пользователь чаще всего взаимодействует с Subbrain.

Output: `docs/design/p7-mockups/A-talk-and-remember.html` (≤600 строк HTML, опираясь на shared/* artifacts).

## Layout (desktop ≥1024px)

Three-column layout:

- **Left sidebar** (260-280px width): список чатов с историей, кнопка «Новый чат» сверху.
- **Center main** (fluid): chat thread с messages, input снизу.
- **Right panel** (320-360px, optional toggle): memory drill-in view (split with chat).

На tablet (768-1023px) — две колонки, right panel прячется в drawer-modal по toggle.
На mobile (<768px) — одна колонка, sidebar = drawer от hamburger в header, memory drill = push на новый screen с back-button.

## Functional flow

### Chat (центральный flow)

1. **Header** сверху чата:
   - Hamburger (mobile only)
   - Model selector (dropdown с виртуальными ролями: teamlead, coder, critic, generalist, chaos, flash, memory)
   - Title чата (editable inline на double-tap)
   - Меню (...): rename, archive, delete

2. **Thread**:
   - 5-7 mock-сообщений: user/assistant alternating
   - Один сообщение в active streaming-симуляции (через `pseudoStream` из utils.js)
   - Reasoning блок: collapsed по умолчанию, click to expand. Показывает `<think>` content между специальным маркером
   - Markdown render для assistant сообщений (basic: bold, italic, code, lists, links)
   - Code blocks с syntax highlighting (заглушка через CSS-класс, не реальный highlighter)
   - Copy-button на каждом сообщении (icon-button)
   - На hover: shows "edit" button for user messages, "regenerate" for assistant

3. **Input** снизу:
   - Textarea, auto-resize до max 8 lines
   - Shift+Enter — newline, Enter — send
   - Кнопки рядом: attach (placeholder), voice (placeholder), send (accent button, disabled когда empty)
   - Counter `<характеры/токены>` (mock value)

4. **Memory candidate-extraction preview** (важная фича):
   - Под последним assistant сообщением, минимально-видимая полоска с маркером "Сейчас в память:".
   - Раскрывается на click — показывает 2-4 candidate-факта которые hippocampus собирается записать.
   - Каждый кандидат: layer badge (shared/context), краткая выжимка факта, confidence score, кнопки [Approve] [Edit] [Reject].
   - Возможность вмешаться до записи.

### Sidebar (history)

- Список 10-12 чатов:
  - Title чата
  - Last-message preview (1 строка truncated)
  - Timestamp (relative: "5м назад", "вчера", "12 апр")
  - Active indicator (accent left-border 2px)
- Topbar: searchbar (filters by title), filter pills (all / pinned / archived)
- Footer: link "🧠 Память" → ведёт в полную memory админку

### Memory drill-in (right panel / push на mobile)

Открывается через:
- Кнопка в header чата ("🧠 Память")
- Click на candidate-extraction preview → открывает с фокусом на этом факте
- Cmd-K → `Search memory: ...` → выбор results

Структура:

1. **Header** панели: title "Память", close button (back на mobile), tabs:
   - Focus / Shared / Context / Archive / Agent / Pending

2. **Search bar** под табами: универсальный search input, filters expand на click.

3. **List** записей текущего layer:
   - Каждая строка: title, content preview (2 lines truncated), tags (badges), confidence (если ≠1.0), updated_at
   - Click → expands inline (или открывает sub-modal на mobile) с full content + actions
   - Actions: [Edit] [Show graph] [Archive] [Delete]

4. **Graph view** (отдельная mode для одной записи):
   - Toggle "View as graph"
   - Canvas/SVG с force-directed network: центральная нода + 8-15 соседей по edges
   - Разные shapes для layer'ов (circle = shared, square = context, diamond = archive)
   - Edges: толщина по weight, цвет по kind (mentions = neutral, contradicts = danger, supersedes = info)
   - Draggable nodes, pan + zoom (touch + mouse)
   - На mobile — упрощённый radial layout (центр + concentric circles)
   - Sidebar справа: detail current selected node + кнопки jump to neighbor

5. **Bi-temporal date picker**:
   - Toggle "View at point in time" в header
   - При активации — calendar input + jump-to-today
   - Выбор даты filters: только записи с `valid_at <= selected`
   - Visible badge "Snapshot 12 апр 2026" на каждой записи которая отличалась бы

6. **Pending inbox** (специальный вид tab Pending):
   - Список 5 candidate-фактов с low confidence
   - Каждый: layer, content, confidence score, source (чат/сообщение)
   - Bulk actions: Select all + [Approve all] [Reject all]
   - Per-row: [Approve] [Edit] [Reject]

### Command palette

Триггер Cmd-K (Ctrl-K). Команды:

- "New chat"
- "Search chats: <query>"
- "Search memory: <query>" (поиск по всем layers)
- "Open chat: <title>" (recent items)
- "Jump to memory entry: <title>"
- "Run night cycle"
- "Toggle agent: autonomous/free-agent/scout"
- "Jump to: A/B/C/D/E/F/G/H страницам"
- Recent items сверху (chats, memory entries, last 5)

Fuzzy match по input. Up/Down arrows для navigation. Enter — execute. Esc — close.

## Mock data needed

Из `shared/mock-data.js`:
- `chats` (12+ объектов с title, messages, model, created_at, updated_at)
- Один current chat — со streaming-симуляцией (текущий ассистент-msg частично написан)
- `memoryFocus`, `memoryShared`, `memoryContext`, `memoryArchive`, `memoryAgent` — все с realistic content
- `memoryEdges` — для graph view (30+ edges)
- `memoryPending` — 5 entries с confidence < 0.8
- 3-4 candidate-extraction factов под current chat

## Components чек-лист

- [ ] Three-column layout с responsive breakpoints
- [ ] Chat header с model selector, editable title, menu
- [ ] Message thread с 5-7 сообщениями, один в streaming-симуляции
- [ ] Reasoning collapse working (click expands `<think>` block)
- [ ] Markdown rendering минимально (bold/italic/code/lists/links)
- [ ] Input с auto-resize, Shift+Enter, send button
- [ ] Sidebar чатов с searchbar, filter pills
- [ ] Active chat indicator (accent left-border)
- [ ] Candidate-extraction preview ниже последнего ассистент-msg, expandable
- [ ] Memory drill-in panel (right на desktop, push-screen на mobile)
- [ ] Memory tabs (Focus/Shared/Context/Archive/Agent/Pending)
- [ ] Memory list с inline expand
- [ ] Graph view toggle с canvas/SVG visualization
- [ ] Bi-temporal date picker toggle
- [ ] Pending inbox tab с bulk actions
- [ ] Command palette (Cmd-K), фильтрация по командам
- [ ] Mobile: drawer для chat-sidebar, push-screen для memory-drill, hamburger menu
- [ ] Empty states: для пустого чата ("Начни разговор..."), для пустой памяти, для пустого pending
- [ ] Toast после: создание нового чата, удаление чата, approve/reject candidate

## Acceptance criteria

- [ ] HTML файл ≤600 строк (включая inline templates)
- [ ] Все взаимодействия из списка работают через vanilla JS из shared/utils.js
- [ ] Streaming-симуляция запускается на page load и завершается через 5-8 секунд
- [ ] Cmd-K открывает palette на любом разрешении
- [ ] Mobile-view (375px viewport): hamburger показывает drawer с чатами; tap на «🧠 Память» делает push-screen с back-button; thread читабельный, input достижим thumb-tap
- [ ] Desktop (1280px viewport): all three columns visible одновременно (с right panel toggleable)
- [ ] Reasoning expand/collapse animates через transition-base
- [ ] Candidate-extraction preview не доминирует визуально, но обнаружим
- [ ] Empty states имеют CTA buttons
- [ ] Контраст всех текстов соответствует tokens (no inline overrides)

## Notes

- Streaming-симуляция: pseudo-stream из utils.js, заглушенный ассистент-msg должен заканчивать мокированный текст, не настоящий API call.
- Graph view — canvas или inline SVG, без подключения d3/cytoscape. Простая реализация: nodes как `<circle>/<rect>`, edges как `<line>`, position через JS (force-directed naive — каждые 16ms пересчёт через damping forces).
- Markdown render — minimal regex-based (нет marked/markdown-it). 5-6 правил achievable.
- Code highlighting — заглушка: `<pre><code class="language-ts">` + CSS классы для keyword/string/comment окраски.
- Voice button и attach button — placeholder без функционала, только показывают tooltip "coming soon".
