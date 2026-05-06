# Task 07 — Connections & Integrations (`G-connections-and-integrations.html`)

## Read first

- [`../00-master-spec.md`](../00-master-spec.md), [`./00-foundation.md`](./00-foundation.md)

## Goal

Mock страницы Telegram-интеграции и future-integrations placeholders.

Output: `docs/design/p7-mockups/G-connections-and-integrations.html` (≤600 строк HTML).

## Layout

3 раздела через табы:

1. **Telegram** — chats list + per-chat settings
2. **Integrations** — registry с placeholders
3. **Webhooks** — config form

## Tab 1 — Telegram

**Top bar:**
- Counter "8 chats • 5 included • 3 excluded"
- Search input (filter by chat name)
- Filter chips: type (private / group / channel / bot), policy (included / excluded / not configured)
- Кнопка [Setup webhook] → opens Tab 3

**Chat list** (desktop split: list left, detail right; mobile: list-only с push на detail):

Каждая chat row:
- Avatar (Lucide user/users/megaphone icon based on type)
- Title (chat name)
- Type badge (private / group / channel / bot)
- Last message preview (1 line, mono if from bot)
- Last message timestamp
- Unread count badge (если есть)
- Policy indicator: 🟢 included для memory_search / ⚪ excluded / 🔴 PII strict
- Click → selects, shows detail в right panel

**Chat detail panel:**

Header:
- Avatar + chat title (h2)
- Type badge + member count (if group)
- Action buttons: [Open in Telegram] (placeholder link), [Refresh metadata]

**Memory policy section:**
- Toggle "Include в memory_search" (switch)
- Toggle "Allow extraction в long-term memory" (switch)
- PII policy radio: Strict (scrub all PII) / Standard (basic phone/email scrub) / None (no scrub)
- Помеченo: "PII config действует с 8e-1..7 wave"

**Scope binding section:**
- "Free-agent шлёт уведомления сюда" toggle (если on — этот chat в FREE_AGENT_TG_CHATS list)
- "Freelance scout шлёт лиды сюда" toggle (override default chat)
- "Approval requests bridge" toggle (если on — operator approval flow через этот chat)

**Recent activity** (collapsible):
- Last 10 messages (mock preview)
- Memory entries extracted из этого chat за last 7 days

**Stats:**
- Total messages indexed
- Memory entries extracted count
- Last indexed_at

**Empty state list:** "Нет чатов. [Setup webhook →]"
**Empty state detail (no chat selected):** "Выбери чат слева"

## Tab 2 — Integrations

Registry с placeholder'ами future-integrations.

**Grid (desktop 2-3 cols, mobile stack):**

Каждый integration card:
- Icon (Lucide outline)
- Title
- Status badge (active / coming soon / disabled)
- Description (2-3 lines)
- Кнопка [Configure] (если active) или [Notify me] (placeholder для future)

Список integrations:

1. **🗓 Google Calendar** (status: coming soon)
   - "Subbrain видит твой календарь, помнит встречи, помогает планировать"
   - [Notify me when ready]

2. **📧 Gmail** (status: coming soon)
   - "Чтение писем, draft-ы ответов, поиск через память"
   - [Notify me when ready]

3. **🔗 Webhooks** (status: active)
   - "Внешние сервисы триггерят actions через HTTP"
   - [Configure] → ведёт на Tab 3

4. **📱 Telegram** (status: active)
   - "Bot + userbot для чтения чатов"
   - [Configure] → ведёт на Tab 1

5. **🌐 Custom MCP servers** (status: coming soon)
   - "Подключить внешний MCP сервер для расширения tool ecosystem"
   - [Notify me when ready]

6. **📅 Notion / Obsidian / RLM vault** (status: coming soon)
   - "Sync с personal knowledge bases"
   - [Notify me when ready]

7. **🔔 OS notifications** (status: coming soon)
   - "Native push-нотификации с macOS / Linux"
   - [Notify me when ready]

8. **🎙 Voice assistants** (status: coming soon)
   - "Wake-word + voice-input через mic"
   - [Notify me when ready]

## Tab 3 — Webhooks

**Section: Outgoing webhooks** (Subbrain → внешние сервисы):

- Description: "Subbrain triggers HTTP requests на эти URL'ы при событиях"
- List existing webhooks (mock 2-3):
  - URL (truncated)
  - Triggered events (chips: memory_write, agent_done, approval_pending)
  - Status (active/disabled)
  - Last fired_at
  - [Edit] [Delete] [Test]
- Кнопка [+ Add webhook] → opens form modal

**Add/Edit webhook form:**
- URL input (with validation)
- Secret token (auto-generated, copy button)
- Events multi-checkbox: memory_write / agent_done / approval_pending / scheduler_tick / error
- Custom payload template (textarea, JSON)
- [Test fire] button — sends mock payload, shows result
- [Save] / [Cancel]

**Section: Incoming webhooks** (внешние сервисы → Subbrain):

- Description: "Telegram использует этот endpoint для bot updates. Другие webhooks могут быть подключены к существующим routes."
- Existing setup card:
  - Telegram bot webhook
  - URL: `https://your-host/telegram/webhook`
  - Status: configured / not configured
  - Secret header: hidden (с reveal toggle)
  - [Update URL] [Remove webhook]

**Empty state outgoing:** "Нет outgoing webhooks. [+ Add first] →"

## Mock data needed

- `telegramChats` (8-10 mixed types: 3 private, 3 groups, 2 channels, 1 bot)
- 1 chat selected по default с full detail mock
- `integrations` (8 placeholders из списка выше)
- 2-3 mock outgoing webhooks
- Telegram bot webhook config mock

## Components чек-лист

- [ ] Tab navigation (3 tabs)
- [ ] Telegram chat list с avatars, type badges, unread, policy indicators
- [ ] Telegram chat detail panel (split desktop, push mobile)
- [ ] Memory policy toggles + PII radio
- [ ] Scope binding toggles
- [ ] Recent activity collapsible
- [ ] Integrations grid с status badges
- [ ] Notify-me buttons (no real action, toast "Уведомим когда готово")
- [ ] Outgoing webhooks list + add/edit form
- [ ] Incoming webhook config display
- [ ] Test fire button (mock — shows skeleton 800ms → mock success result)

## Acceptance criteria

- [ ] HTML ≤600 строк
- [ ] All 3 tabs работают
- [ ] Telegram chat selection: click row → detail panel updates с правильным контентом
- [ ] Mobile: chat list-only, tap → push-screen с detail + back-button
- [ ] Toggles в chat detail имеют визуальный feedback + toast при flip
- [ ] Notify-me buttons: показывают toast "Сохраним и сообщим когда {integration} готов"
- [ ] Add webhook form: validation на URL (required, http(s)://), secret auto-generates
- [ ] Test fire button: animation skeleton → green success card с mock 200 OK response
- [ ] Empty states работают

## Notes

- Avatars: Lucide icons по type (user / users / megaphone / bot). Color из tertiary background.
- PII policy radio — заглушка без реального backend wire. Save → toast "Saved (will activate в Wave 3)".
- Webhook URL validation: regex check `^https?://`. Show inline error если invalid.
- Test fire — `setTimeout` 800ms, потом render mock response card. Без real fetch.
- Secret token reveal: button toggles `<input type="password">` ↔ `<input type="text">`.
