# Task 04 — Control & Trust (`D-control-and-trust.html`)

## Read first

- [`../00-master-spec.md`](../00-master-spec.md), [`./00-foundation.md`](./00-foundation.md)

## Goal

Mock страницы approval-flow, audit-log, memory rollback, confidence-tuner. Сюда пользователь идёт когда хочет понять что система собирается делать и контролировать её безопасность.

Output: `docs/design/p7-mockups/D-control-and-trust.html` (≤600 строк HTML).

## Layout

Sticky header с page title "Контроль".

4 раздела (можно как табы или как stacked sections с anchor-nav):

1. Approval inbox
2. Audit timeline
3. Memory rollback
4. Confidence tuner

Tabs более привычны и удобнее на mobile. Идём с табами.

Tab navigation: «Inbox» / «Audit» / «Rollback» / «Confidence»

## Tab 1 — Approval Inbox

Mirror Telegram operator-channel.

**Top bar:**
- Counter "5 pending" (accent badge)
- Bulk actions toolbar (если selected): [Approve all] [Reject all] [Cancel]
- Filter chips: action_type (tool_call / memory_write / tg_send / dangerous_action), agent_id

**List of pending approvals:**

Каждая карточка:
- Top row: agent_id badge + action_type badge + timestamp ("3 мин назад") + checkbox для bulk
- Title: краткое описание действия ("Отправить TG в @client_chat: 'Здравствуйте, ...'")
- Expandable section (chevron-down): full context
  - **What:** полный action_payload (formatted JSON syntax-highlighted)
  - **Why:** reasoning agent'а (markdown text)
  - **Context facts:** список memory entries которые agent использовал для решения (clickable, открывает в memory drill-in на странице A)
- Bottom row:
  - Кнопка [Approve] (primary green)
  - Кнопка [Reject] (danger)
  - Comment textarea (optional, expandable inline)
  - "Expires в 2ч" (если есть expires_at)
- Click на карточку → expand inline (на mobile push-screen с full detail)

**Telegram bridge indicator:**
- Sticky info-bar сверху "🔄 Synced с Telegram • bulk actions подтверждаются обоюдно"

**Empty state:** "Нет ожидающих одобрений 🌿"

## Tab 2 — Audit Timeline

Все approval-решения за период.

**Top bar:**
- Date range picker (presets: today / 24h / 7d / 30d / all)
- Filter chips: outcome (approved/rejected/expired), agent_id, action_type, responded_via (web/telegram)
- Search input (по action_payload text)

**Timeline list:**
- Vertical timeline с dots (Lucide circle, accent если approved, danger если rejected, tertiary если expired)
- Каждая запись:
  - Timestamp (absolute + relative)
  - Outcome badge
  - Action_type + brief
  - Agent_id chip
  - Responded_via badge ("via web" / "via telegram")
  - Comment (если был) в italic secondary
- Click → opens detail-modal с full context (как в Inbox expand)

**Stats summary** сверху:
- "За период: approved 12 • rejected 4 • expired 2 • total 18"

## Tab 3 — Memory Rollback

Restore-flow для archived записей.

**Layout (split):**

Left: Archive browser
- Search input
- Filter: original_layer (shared / context / agent)
- Sort: archived_at DESC, content alpha
- List of 10-15 archived entries: title, content preview (1 line), original_layer badge, archived_at, original confidence
- Click → selects, shows preview в right panel

Right: Preview & Restore
- Selected entry detail:
  - Full content (read-only)
  - Original metadata (layer, tags, edges, confidence, created_at, archived_at)
  - Какие edges связаны (если any)
- Кнопки:
  - [Restore to {original_layer}] (primary accent)
  - [Restore to different layer] (опция выбрать новый layer dropdown → secondary button)
  - [Delete permanently] (danger, требует confirm modal)
- Если restore: toast "Восстановлено в {layer}"

**Mobile fallback:** stacked, list сверху, выбранная entry открывается push-screen с preview + restore actions.

**Empty state:** "Архив пуст"

## Tab 4 — Confidence Tuner

Управление threshold для auto-accept memory writes.

**Current threshold display:**
- Big slider 0.0 - 1.0, current value highlighted (default 0.8)
- Live preview: "При threshold {X}: за last 7 days {N} записей попало бы в pending"

**Histogram:**
- Vertical bar chart confidence-distribution (10 buckets: 0.0-0.1, ..., 0.9-1.0)
- Каждый bucket: high contains current entries
- Vertical line на slider position через histogram (visual cutoff)
- Над/под line: "Auto-accept N entries / Pending N entries"

**Layer selector:**
- Tabs: Shared / Context (separately tunable)
- Current threshold per layer

**Save button:**
- [Apply] (primary) — сохраняет new threshold
- [Reset to default] (ghost)

**Educational tooltip:**
- "ℹ️ Как это работает": Hover/tap → tooltip с объяснением "Записи с confidence ниже threshold уходят в pending для ручного approve. Высокий threshold = больше контроля, низкий = больше автоматики."

## Mock data needed

- `approvals.pending` (5-6 объектов: разные action_types, разные agent'ы, mix expires_at)
- `approvals.audit` (20+ entries за last 30 days)
- `memoryArchive` (10-15 entries с realistic content для rollback)
- `confidenceDistribution` для shared и context: array из 10 buckets с counts

## Components чек-лист

- [ ] Tab navigation (4 tabs)
- [ ] Approval inbox с expandable cards, bulk actions, filter chips
- [ ] Telegram bridge indicator sticky
- [ ] Audit timeline с vertical dots, filter bar, stats summary
- [ ] Memory rollback split-layout (list + preview), restore actions
- [ ] Confidence tuner со slider + histogram + per-layer tuning
- [ ] All forms client-side только (no real API)
- [ ] Empty states для всех 4 табов

## Acceptance criteria

- [ ] HTML ≤600 строк
- [ ] All 4 tabs работают, url fragment switches
- [ ] Bulk select в Inbox: chekboxes на cards, action bar появляется когда ≥1 selected
- [ ] Approve/Reject в Inbox: card fade-out с animation, toast "Approved/Rejected", counter в top bar обновляется
- [ ] Audit filter chips реально фильтруют list (client-side из mock array)
- [ ] Confidence slider live-обновляет preview text + histogram cutoff line
- [ ] Mobile: tabs scrollable, approval card expand → push-screen, rollback split → stacked
- [ ] Memory rollback select left → preview right ("чтобы не было путаницы при выборе")

## Notes

- JSON syntax highlight в expandable: regex-based колонки на keys (accent), strings (success), numbers (info). Не реал highlighter.
- Histogram: SVG bars, height по count proportional. ~10 bars макс.
- Slider — native `<input type="range" step="0.05" min="0" max="1">` стилизованный через CSS (accent thumb).
- Comment textarea на approval — auto-expand на focus (max-height 120px, scrollable дальше).
- Telegram bridge indicator — статичный текст, без реальной sync (мок).
