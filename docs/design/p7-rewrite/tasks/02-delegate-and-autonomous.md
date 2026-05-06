# Task 02 — Delegate & Autonomous (`B-delegate-and-autonomous.html`)

## Read first

- [`../00-master-spec.md`](../00-master-spec.md), [`./00-foundation.md`](./00-foundation.md)

## Goal

Mock страницы для делегирования задач агентам, мониторинга агентного pool'а, управления автономными schedulers, просмотра A2A-комнат.

Output: `docs/design/p7-mockups/B-delegate-and-autonomous.html` (≤600 строк HTML).

## Layout

Tab-based navigation сверху страницы:

1. **Запуск** — task launcher form + live preview работающего агента
2. **Pool** — текущая очередь и активные runs
3. **История** — past runs с фильтрами
4. **Schedulers** — autonomous, free-agent, scout панели
5. **A2A комнаты** — transcripts list + drill-in viewer

На mobile все табы сохраняются, но layout single-column.

## Functional flow

### Tab 1: Запуск

**Task launcher form:**

- Textarea: задача (placeholder "Что нужно сделать?")
- Selector: модель/role (teamlead default, dropdown all виртуальных моделей)
- Slider: budget steps (5-100, default 12)
- Optional: scope dropdown (default / autonomous / free-agent / freelance / tg)
- Optional: priority slider (0-10)
- Кнопка [Launch] (primary accent)

**Live preview** под формой (если есть active run или после launch):

- Header: задача, модель, started_at, кнопка [Stop]
- Live stream шагов: каждый step как карточка
  - Step number, type (think / tool_call / final), timing
  - Если tool_call: tool name + input + output (collapsed by default)
  - Если think: reasoning text
  - Если memory_write: highlight с layer badge
  - Если final: assistant final answer
- Pulse-animation на текущем step
- Progress bar внизу: "step 7 / 12"
- Кнопка [View full trace] → ведёт в Observability F-page для этого run.id
- Кнопка [Copy prompt to new chat] → opens chat A-page с pre-filled

### Tab 2: Pool

**Current queue panel** (слева на desktop, top on mobile):

- Список активных runs (max 5+ в моке)
- Каждая: title (краткое описание задачи), agent_id (e.g. "autonomous-3"), scope badge, model, current step number, progress bar, started_at, кнопки [View] [Stop]
- Pulse-animation на active step

**Rate-limit usage** (справа на desktop, ниже на mobile):

- Per-provider карточки: NVIDIA, MiniMax, OpenRouter
- Каждая: current RPM / limit RPM как visual bar (accent fill), queue depth
- Last-error indicator (timestamp если был в last 5 min)

**Empty state:** "Нет активных runs. [Launch new] →"

**Mobile fallback:** только список активных карточек без графиков rate-limit. Rate-limit перенесён в Health panel страницы F.

### Tab 3: История

- Filter bar сверху: status (success/failed/cancelled/timeout), scope, agent_id, since (1h/24h/7d/30d)
- Search input (filter by task text)
- List of past runs — каждая строка:
  - Status badge (success green / failed red / cancelled gray / timeout warn)
  - Task title (1-line)
  - Model + scope badge
  - Timing: total duration (mm:ss)
  - Steps used / max
  - Cost (mock $)
  - timestamp (relative)
  - Click → opens run detail (push на mobile, modal на desktop)
- Pagination cursor-based ("Load more" button)

### Tab 4: Schedulers

Stack of three scheduler cards:

**1. Autonomous loop:**
- Status badge (running / idle / paused / error)
- Last run: timestamp + result (success/failed)
- Next tick: timestamp (если scheduled)
- Кнопки: [Start] / [Stop] / [Run now]
- Inline config:
  - Max steps (number input, default 100)
  - Default model (dropdown)
- Recent activity (last 5 runs, links в History)

**2. Free agent:**
- Status, last_run_at, next_tick_at, кнопки
- Inline config:
  - Interval (minutes, default 60)
  - Max steps (default 50)
  - Custom prompt (textarea, placeholder "Override default curiosity prompt...")
  - **Target chats**: multi-select Telegram chats (mock list 5-7), highlight что включено. На mobile отдельный modal-picker.
  - Note ниже: "Multi-chats требует backend addition: FREE_AGENT_TG_CHATS"
- Recent findings (last 5 TG-digests links)

**3. Freelance scout:**
- Status, last poll, next tick
- Кнопки start/stop
- Inline config:
  - Poll interval (minutes)
  - Categories (chips, multi-select)
  - Min/max budget (RUB)
  - Threshold для alert (score 0-1)
  - TG target chat
- Recent leads counter ("12 за сегодня, 4 high-score")
- Link [View leads] → opens drill (modal или separate panel) с recent leads

### Tab 5: A2A комнаты

**List view:**
- Карточки последних 10 комнат
- Каждая: title (задача), team_lead role, participants chips, started_at, status badge
- Click → opens transcript viewer

**Transcript viewer (drill-in):**

Desktop layout:
- Left tree (260px): conversation tree
  - Root: задача
  - Раунды как nodes (Round 1, Round 2, Round 3)
  - Внутри раунда — sub-nodes per participant (teamlead, coder, critic, generalist)
  - Final synthesis как leaf node
- Right detail (fluid): full content of selected node
  - Role badge, timestamp, tokens, latency
  - Markdown-rendered content
  - При selected = participant: inline reasoning блок
  - Кнопка [Copy] [Jump to full run trace]

Mobile layout:
- Линейный thread сверху вниз
- Каждое message: indent по уровню (Round depth)
- Role badge sticky слева
- Tap на message → push-screen с full content + reasoning

**Empty state:** "Нет завершённых A2A-комнат. Запусти задачу с teamlead-моделью..."

## Mock data needed

- `agents.pool` — 5 active runs
- `agents.history` — 15+ past runs
- `agents.schedulers.autonomous`, `.freeAgent`, `.freelanceScout` — config + status
- `agents.a2aRooms` — 3+ rooms, один с full transcript (Round 1: teamlead+coder+critic, Round 2: teamlead+critic, Round 3: final synthesis)
- `leads` — last 10 freelance leads для recent findings
- Provider rate limits (mock RPM current/max)

## Components чек-лист

- [ ] Tab navigation (5 tabs) с url-fragment sync (#запуск, #pool, etc.)
- [ ] Task launcher form со всеми полями + validation на client
- [ ] Live stream simulation после Launch (через setInterval добавляем шаги)
- [ ] Step карточки с разными типами (think / tool / final / memory_write)
- [ ] Pool monitor с активными карточками + rate-limit bars (desktop only)
- [ ] History list с фильтрами + pagination
- [ ] Three scheduler cards с inline config edit
- [ ] Free-agent target-chats multi-select
- [ ] A2A list view + transcript viewer (tree desktop / linear mobile)
- [ ] Mobile: tabs accessible через scroll-x (или bottom-sheet selector), pool card-only view, A2A linear

## Acceptance criteria

- [ ] HTML ≤600 строк
- [ ] All 5 tabs функционируют
- [ ] Live stream симуляция убедительна (новый шаг каждые 1.5-2с, итого 8-12 шагов за 20с)
- [ ] Stop button "останавливает" симуляцию (clears interval, видит stopped state)
- [ ] Pool monitor показывает несколько одновременных runs
- [ ] Mobile: rate-limit panel НЕ показывается в Pool tab, перенаправляет в F page
- [ ] A2A tree view collapses/expands subtrees
- [ ] Scheduler config saves локально (не настоящий API), показывает toast "Settings saved"
- [ ] Empty states для каждого tab если нет данных
- [ ] Все кнопки имеют правильные disabled-states (Launch disabled когда textarea empty)

## Notes

- Live stream: каждые 1.5-2с push новый mock-step в массив, re-render через template clone. Автоматический stop через 20с.
- Rate-limit bars: SVG path или CSS animated bar. Mock values: NVIDIA 18/40, MiniMax 4/30, OpenRouter 0/60.
- A2A tree: SVG-based или простой nested `<ul>` с CSS-tree-styling (border-left). Не реал tree library.
- Free-agent target chats: data-mock из `telegramChats`, чекбоксы. Multi-select в shared `<datalist>` или custom dropdown.
- Если scheduler-инлайн-edit становится сложным, fallback: «Edit config» button → modal с формой.
