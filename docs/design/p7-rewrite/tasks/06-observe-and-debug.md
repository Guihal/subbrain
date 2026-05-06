# Task 06 — Observe & Debug (`F-observe-and-debug.html`)

## Read first

- [`../00-master-spec.md`](../00-master-spec.md), [`./00-foundation.md`](./00-foundation.md)

## Goal

Mock observability страницы: cost/latency dashboard, run trace viewer, logs explorer, health panel. Сюда пользователь идёт чтобы понять что система делает, сколько стоит, где зависает.

Output: `docs/design/p7-mockups/F-observe-and-debug.html` (≤600 строк HTML).

## Layout

4 раздела через табы:

1. **Dashboard** — cost/latency/tokens/errors metrics
2. **Runs** — trace viewer для agent-runs
3. **Logs** — explorer с фильтрами
4. **Health** — system snapshot

## Tab 1 — Dashboard

**Period selector** сверху: Today / Week / Month / Custom

**Stat cards row** (desktop: 4 cols; mobile: 2 cols stacked):

Каждая карточка:
- Label (small uppercase tertiary)
- Big number (h1, semibold)
- Delta vs previous period ("+12% vs вчера" — green/red color based on direction)
- Mini sparkline под (32px height, accent stroke)

4 cards:
- 💰 Total cost ($X.XX)
- 🔢 Total tokens (input + output как breakdown)
- ⏱ Avg latency (p50)
- ⚠ Error rate (%)

**Sparkline panel** (full-width):
- 4 sparkline charts side-by-side (desktop) или stacked (mobile)
- Каждый: label, x-axis time labels (hourly bucket), y-axis скрытая
- Точки hovered показывают tooltip "12:00 — $0.42"

**By-model breakdown** (table):
- Columns: Model | Calls | Tokens | Cost | p50 latency | p95 | Error rate
- Rows: каждая виртуальная роль (teamlead, coder, critic, generalist, chaos, flash, memory)
- Sortable headers
- Hover row: highlights
- Mobile: cards вместо table (one card per model)

**By-provider breakdown** (table):
- Columns: Provider | RPM current/limit | Total calls | Errors | Last error
- Rows: NVIDIA, MiniMax, OpenRouter, cliproxy
- Visual RPM bar в RPM column

## Tab 2 — Runs

Trace viewer для agent-runs.

**Top filters:**
- Period (today / 7d / 30d)
- Status (running / success / failed / cancelled / timeout)
- Scope chips
- Agent_id select
- Search input (по task text)

**Run list** (left panel, desktop, или first view mobile):

Каждая row:
- Status badge
- Task title (1-line)
- Model badge
- Total duration
- Steps used / max
- Cost
- Started_at
- Click → opens trace viewer

**Trace viewer** (right panel desktop, push-screen mobile):

**Header:**
- Run id (mono short)
- Task title
- Status, model, started_at, ended_at, total_duration, total_cost
- Кнопка [Copy as new run] [View related logs]

**Desktop layout (timeline + tree):**

Top: Horizontal timeline
- Bars представляют каждый step, ширина по duration, color по type (think gray, tool_call accent, memory_write info, final success)
- Hover на bar → tooltip с step preview
- Click → highlights в tree ниже

Below: Tree view
- Expandable nodes, каждый — step
- Структура:
  - Step #1 [think] — duration, expandable → reasoning text
  - Step #2 [tool_call: web_search] — duration, expandable → input + output JSON
  - Step #3 [memory_write] — layer + content
  - ...
  - Final answer (leaf node)
- Click step → focuses в timeline + scroll-into-view

**Mobile fallback (timeline-only):**
- Vertical timeline без tree
- Каждый step как card в timeline
- Tap → push-screen с full step detail
- Без tree-структуры

**Empty state run list:** "Нет runs за период"

## Tab 3 — Logs

**Top bar:**
- Search input (full-text по log content)
- Filter chips: session_id, request_id, role (user/assistant/system/tool/agent/scheduler), level (info/warn/error/debug), time range
- Time range picker

**Stats summary:**
- "За период: 234 entries • 12 sessions • 4 errors"
- Click error count → filters только errors

**Logs list (virtualized feel):**

Each row:
- Timestamp (mono, relative)
- Role/level badge
- Session_id chip (mono, truncated 8 chars, click filters by session)
- Stage chip (pre/main/post если applicable)
- Message preview (1 line truncated, mono if JSON)
- На hover: actions [Copy] [Pin to context] [Open session]
- Click row → expands inline (на mobile push-screen) с full detail panel:
  - Full message (syntax-highlighted JSON если applicable)
  - Metadata (request_id, latency, tokens если есть)
  - **Quick-link** "↑ что было ДО в этой сессии" / "↓ что было ПОСЛЕ" — стрелки на context

**Skeleton loading:** на page load показываем 10 skeleton rows.

**Pagination:** "Load more" button внизу (cursor-based, мок).

## Tab 4 — Health

**Big status banner** сверху:
- Если ok: "🟢 All systems operational"
- Если есть warnings: "🟡 1 issue: NVIDIA RPM at 95%"
- Если errors: "🔴 1 critical: backup failed 3h ago"

**Sections (stacked cards):**

1. **System info:**
   - Version (mono)
   - Uptime (formatted "3д 4ч 12м")
   - Memory used (MB / total MB, with bar)
   - DB size (MB)
   - Deployment health (last deploy_at, status)

2. **Providers:**
   - Stack of cards per provider (NVIDIA / MiniMax / OpenRouter / cliproxy)
   - Каждая: name, current RPM with bar (current / limit), queue depth, total calls today, last error timestamp + message (если был)

3. **Schedulers:**
   - Stack of cards per scheduler (autonomous / free-agent / freelance / night-cycle / recurring)
   - Каждая: name, status (running/idle/error), last_run_at, next_tick_at (if scheduled), кнопки [Start] [Stop] [Run now]

4. **Backup:**
   - Last backup at, size, retention_days, next_scheduled_at
   - Manual trigger button [Run backup now] (с confirm modal)

**SSE indicator:**
- Маленький "🟢 Live" indicator в header (pulse-animation)
- В реальной системе обновлялось через SSE каждые 5s, в моке — `setInterval` обновляет некоторые числа (RPM particularly)

## Mock data needed

- `observability.costToday` (totals + by-model breakdown)
- `observability.costSparkline` (24 hourly buckets)
- `observability.runs` (10+ traces, один с full step-by-step)
- `observability.logs` (50 log entries разных roles + levels)
- `observability.health` (providers, schedulers, backup status, system info)

## Components чек-лист

- [ ] Tab navigation (4 tabs)
- [ ] Dashboard: 4 stat cards с sparklines, by-model table, by-provider table с RPM bars
- [ ] Runs: list + trace viewer (timeline desktop / linear mobile)
- [ ] Tree view с expand/collapse, step type colors
- [ ] Logs: list с filters, expandable rows, before/after navigation
- [ ] Health: 4 sections + big status banner + live indicator pulse
- [ ] Mobile: dashboard cards stack 2-col, runs list-only с push, tree → linear timeline
- [ ] Skeleton loading на initial render

## Acceptance criteria

- [ ] HTML ≤600 строк
- [ ] All 4 tabs работают
- [ ] Sparklines рисуются (SVG path) с realistic-looking data
- [ ] By-model table sortable: click header → reorders rows
- [ ] Run trace timeline + tree synced: click bar → tree node expands и highlight
- [ ] Mobile: timeline только vertical, no tree, push-screen для step detail
- [ ] Logs filter chips работают (multi-filter combinable)
- [ ] Logs row expand inline desktop, push mobile
- [ ] Logs before/after navigation: показывает 5 entries до и после в той же session
- [ ] Health live indicator: pulse animation, RPM значения "тикают" каждые 3-5s через setInterval
- [ ] Empty states для пустого runs list, пустого logs filter

## Notes

- Sparklines: SVG `<path>` с simple linear interpolation между points. Не реал charting library.
- Tree view: nested `<ul>` с custom CSS. `<details>/<summary>` semantic для accessibility.
- Timeline bars: SVG `<rect>` с position и width pre-calculated. Tooltip через CSS hover (или JS для mobile tap).
- JSON syntax-highlighting в logs detail: тот же regex-based mock что в codetool editor (Task 05).
- "Live" indicator: CSS @keyframes pulse 2s infinite на маленьком dot.
- RPM bars животные: linear gradient + animated width.
