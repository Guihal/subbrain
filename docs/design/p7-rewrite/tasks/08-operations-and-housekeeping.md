# Task 08 — Operations & Housekeeping (`H-operations-and-housekeeping.html`)

## Read first

- [`../00-master-spec.md`](../00-master-spec.md), [`./00-foundation.md`](./00-foundation.md)

## Goal

Mock страницы операций: night cycle, backup, settings, system status. Сюда пользователь идёт чтобы управлять самой системой (то что обычно делает SSH в /opt/subbrain).

Output: `docs/design/p7-mockups/H-operations-and-housekeeping.html` (≤600 строк HTML).

## Layout

**Sticky system status header** сверху страницы (всегда виден):

- Layout: horizontal flex, padding minimal
- Слева: version badge (mono), uptime ("3д 4ч"), memory bar (compact), DB size
- Справа: deployment health indicator (🟢 healthy / 🟡 warning / 🔴 issue), last_deploy_at ("обновлено 2д назад")
- Sticky position-top, surface-1 background

Под header — 4 раздела через табы:

1. **Operations** — night cycle + backup big-button actions
2. **Settings** — auth, providers, feature flags, advanced
3. **History** — past operations log
4. **Diagnostics** — health snapshot + connection tests

## Tab 1 — Operations

**Section A: Night Cycle**

Card layout:
- Header: "🌙 Night Cycle"
- Status indicator: 🟢 idle / 🟡 running / 🔴 last failed
- Last run: timestamp + result badge ("success — 12 entries processed in 47s")
- Next scheduled: "сегодня в 03:00 UTC" (или Disabled note если scheduler off)
- **Big primary button** [▶ Run now]
  - При click: shows confirm modal "Запустить night cycle сейчас? Может занять 1-5 минут."
  - После confirm: button → "Running...", progress dots animation, после 8s mock-success → toast "Night cycle complete: 14 entries processed"
- Secondary buttons: [View last run logs] [Configure schedule]

**Schedule config modal:**
- Hour UTC selector (0-23)
- Backlog trigger threshold input
- Enable/disable toggle
- [Save] / [Cancel]

**Section B: Backup**

Card layout:
- Header: "💾 Backup"
- Last backup: timestamp + size ("12.3 MB • 4ч назад")
- Retention: "30 days"
- Next scheduled: "сегодня в 04:00 UTC"
- **Big primary button** [▶ Run backup now]
  - Confirm modal "Запустить VACUUM INTO бэкап?"
  - После confirm: progress + mock success toast "Backup complete: subbrain-2026-05-06.db (13.1 MB)"
- Secondary: [View backup history] (ведёт в Tab 3) [Configure retention]

**Backup history quick view** (collapse):
- Last 5 backups: timestamp, size, status (success/failed), location

**Section C: Reset / dangerous actions** (collapsed по default, header "⚠️ Опасные действия"):
- [Reset memory layer X] — выбор layer + double-confirm modal
- [Clear logs older than X days] — period selector + confirm
- [Restart server] — placeholder (в реальной системе через PM2/Docker)

## Tab 2 — Settings

Group sections:

### A. Authentication

- Current token (masked, reveal toggle)
- Last rotated: timestamp
- [Rotate token] button → confirm + reveal new token + warn "Сохрани, больше не покажется"

### B. Providers (read-only env-derived)

Stack of provider cards:
- NVIDIA NIM: model role mapping (teamlead → glm-5.1, coder → deepseek-v4-flash, etc.) — read-only display
- MiniMax: model + status (configured / not configured)
- OpenRouter: model + API key (masked)
- cliproxy bridge: enabled/disabled, OAuth status

Note: "Providers конфигурируются через env. Чтобы изменить — отредактируй .env и рестарт."

### C. Feature flags (runtime override)

Table:
| Flag | Current | Default | Action |
|---|---|---|---|
| NIGHT_CYCLE_HOUR_UTC | 3 | 3 | [Edit] |
| FREE_AGENT_INTERVAL_MIN | 60 | 60 | [Edit] |
| FREE_AGENT_MAX_STEPS | 50 | 50 | [Edit] |
| AUTONOMOUS_MAX_STEPS | 100 | 100 | [Edit] |
| FREELANCE_POLL_MIN | 30 | 30 | [Edit] |
| MEMORY_AUTOACCEPT_CONFIDENCE | 0.8 | 0.8 | [Edit] |
| POST_EXTRACTOR_MODEL | memory | memory | [Edit] |

Edit row → inline input + [Save] / [Cancel]. После save: toast + [Reset to default] для конкретного flag.

### D. Advanced

- Debug mode toggle (verbose logging)
- Hippocampus enabled toggle
- Free agent enabled toggle
- Freelance scout enabled toggle
- Telegram bot enabled toggle
- Каждый — switch с пояснительным текстом ниже

### E. Export / Import

- [Export memory dump] (JSON download mock)
- [Export config] (env file download mock)
- [Import config] (file picker, validation mock)

## Tab 3 — History

Past operations log.

**Filter chips:** type (night-cycle / backup / restore / reset), status (success / failed), period (7d / 30d / all)

**List:**
- Каждая row:
  - Timestamp
  - Operation type icon + name
  - Status badge
  - Duration
  - Brief result ("12 entries processed", "13.1 MB", etc.)
  - Triggered_by ("scheduled" / "manual via web" / "manual via SSH")
- Click → expand inline (или modal на mobile) с full detail:
  - Full result JSON
  - Logs (excerpt)
  - Errors (если были)

**Stats summary:**
- "За период: 14 night-cycles • 7 backups • 0 restores • 1 failure"

## Tab 4 — Diagnostics

Health snapshot + test buttons.

**Status cards (stacked):**

1. **System health:**
   - Overall: 🟢 healthy
   - CPU usage: bar 32%
   - Memory usage: bar 64% (640MB / 1GB)
   - Disk usage: bar 18% (1.2GB / 7GB)
   - DB size: 12.3 MB

2. **Database:**
   - Status (connected / error)
   - Tables count
   - Total rows (across major tables)
   - FTS5 index size
   - Vector index size
   - WAL mode active
   - [Run VACUUM ANALYZE] button → mock success после 2s

3. **Providers:**
   - Compact list per provider: name, current status (✅ ok / ⚠ degraded / ❌ down), last successful call_at
   - [Test connection] button on each → mock skeleton 1s → success/fail result

4. **MCP server:**
   - Status, transport (REST + JSON-RPC + agent-only) — все green
   - Tool count: 12 public + 8 agent-only
   - [List all tools] → ведёт в страницу E

5. **Telegram:**
   - Bot status, userbot status
   - Last update_at
   - Webhook configured: yes/no
   - [Test send] button → отправит test message в default chat (mock confirm)

**Test buttons row:**
- [Run all health checks] — orchestrates все вышестоящие tests, показывает progress

## Mock data needed

- `operations.nightCycle` (status, last 7 runs history)
- `operations.backup` (status + last 5 backups)
- `operations.systemInfo` (version, uptime, memory, CPU, disk)
- Feature flags array (6-7 entries)
- Operations history (20+ entries mix of types/statuses)
- Diagnostics data per provider/component

## Components чек-лист

- [ ] Sticky system status header
- [ ] Tab navigation (4 tabs)
- [ ] Big-button actions (Run night cycle, Run backup) с confirm modals
- [ ] Mock progress animations + success toasts
- [ ] Settings sections (auth, providers, feature flags table, advanced toggles, export/import)
- [ ] Feature flag inline edit (row → input + save)
- [ ] History list с filter chips
- [ ] Diagnostics cards с status indicators + test buttons
- [ ] Test connection buttons (mock skeleton → result)
- [ ] Dangerous actions collapsed section с double-confirm

## Acceptance criteria

- [ ] HTML ≤600 строк
- [ ] All 4 tabs работают
- [ ] Big-button "Run night cycle" — confirm → progress → success toast (mock 8s)
- [ ] Backup button аналогично
- [ ] Feature flags inline edit: click [Edit] → input + save/cancel buttons → save → toast
- [ ] Token rotate: opens confirm modal с warning, после confirm shows new token only once с copy button
- [ ] Diagnostics test buttons: каждая показывает skeleton 1s → mock result (mostly success)
- [ ] History filter chips реально фильтруют
- [ ] Mobile: tabs scrollable, big buttons full-width, status cards stack
- [ ] Sticky header sticky на scroll, не overlap'ит content (proper top padding)
- [ ] Dangerous actions: первый click expand section, реальное действие требует двойной confirm

## Notes

- Big-button: large size variant (`.btn--lg`), full-width на mobile, accent background.
- Progress animation для "Running...": replace button text + animated dots (`.` `..` `...`) через interval.
- Toast после operations: с link "[View in History →]".
- Test buttons возвращают всегда success (мок). Один-два провайдера могут быть в "degraded" state для discriminator.
- Token reveal modal: после rotate показывает токен только один раз. После close — disappears, replaced by masked.
- Feature flag types: number / string / boolean / enum. Inline input соответствует type.
- Export buttons: создают `<a download>` с mock JSON content.
