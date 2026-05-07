# Task 05 — Extend & Customize (`E-extend-and-customize.html`)

## Read first

- [`../00-master-spec.md`](../00-master-spec.md), [`./00-foundation.md`](./00-foundation.md)

## Goal

Mock страницы расширения: plugin admin, MCP tool browser/tester, code-tool editor.

Output: `docs/design/p7-mockups/E-extend-and-customize.html` (≤600 строк HTML).

## Layout

3 раздела через табы:

1. **Plugins** — installed plugin admin
2. **MCP tools** — инвентарь и tester инструментов
3. **Code-tools** — editor для динамических кодовых инструментов

## Tab 1 — Plugins

**Top bar:**
- Counter "5 installed • 1 disabled • 1 error"
- Search input
- Filter chips: enabled / disabled / error
- Кнопка [Install plugin] (placeholder без real install UI — opens info modal "External plugin loader будет в Wave 3")

**Plugin grid** (desktop: 2-3 cols; mobile: stack):

Каждая plugin card:
- Header row: plugin name (semibold), version badge (mono), status indicator (green dot / gray / red)
- Description (2-3 lines)
- Hooks registered (chips): "pre-tool", "post-phase", "memory-write"
- Bottom row buttons:
  - Toggle [Enabled / Disabled] (switch)
  - [Reload] (icon-button)
  - [View hooks] → modal со списком зарегистрированных hooks
  - [Configure] → modal с plugin-specific settings (заглушка с textarea для JSON config)
- Если status=error: red banner inline с last error message + кнопка [View logs]

**Hooks detail modal (для plugin):**
- List зарегистрированных hooks
- Каждый: hook type (pre-tool/post-phase/etc.), target (tool name или phase name), priority, attached_at timestamp
- Read-only

**Empty state:** "Установлен только core. [Подключить плагин →] (info)"

## Tab 2 — MCP Tools

**Layout (split на desktop):**

Left: Tool list
- Search input (filter by name/description)
- Filter chips: scope (public / agent-only)
- List of 12+ tools, каждый row: name (mono), scope badge, description (1-line truncated)
- Click → selects, shows detail в right panel

Right: Tool detail + tester

**Detail section:**
- Tool name (h2 mono)
- Description (full)
- Scope badge
- Input schema (JSON Schema formatted, syntax-highlighted)
- Output schema (опционально, тот же style)
- Examples (если есть): pre-built sample inputs

**Tester:**
- Section header "🧪 Try it"
- Form generated from input schema:
  - Каждое property → подходящий control (string → input, integer → number input, boolean → switch, enum → select, object → expandable nested form, array → list with [+] button)
  - Required marked с `*`
  - Help text из schema description
- [Execute] button (primary)
- Result panel ниже:
  - On success: green border, formatted JSON output, latency badge
  - On error: red border, error message + stack
  - Loading state: skeleton

**Mobile:** list-only по default, click → push-screen с detail+tester. Back-button возвращает.

**Empty state:** "Инструментов нет (это странно)"

## Tab 3 — Code-tools

Editor для динамических кодовых инструментов.

**Layout:**

Left sidebar (260-300px desktop / drawer mobile): Tool list
- Search
- Filter: created_by (agent / manual)
- Each row: tool name, description (1 line), updated_at, status badge (active/disabled)
- Click → opens в main editor area

Main editor area:
- Top toolbar:
  - Tool name (editable inline)
  - Description (editable)
  - Status toggle (active/disabled)
  - [Save] (primary, disabled if no changes)
  - [Delete] (ghost danger, confirm modal)

- **Code area** (Monaco-style mock):
  - `<pre><code>` block с syntax-highlighted кодом
  - **НЕ настоящий редактор** — это заглушка
  - Use textarea overlay invisible над `<pre>` for "edit-feel": user пишет в textarea, текст синхронизируется в pre с подсветкой
  - Lines numbered слева
  - Подсветка через CSS classes (regex-based mock highlighter):
    - keywords (function, const, return, if, etc.) → accent color
    - strings (double/single quotes) → success
    - comments → tertiary italic
    - numbers → info
- Sample mock code: каждая tool в `codeTools` mock-data имеет ~30-50 строк JS

- **Sandbox runner panel** (под editor):
  - Header "🧪 Test run"
  - Input: textarea для test input JSON
  - [Run in sandbox] button
  - Output area (syntax-highlighted JSON, либо error)
  - Timing badge ("47ms")

- **Run history panel** (sidebar справа на desktop, отдельный modal на mobile):
  - List 5-10 past runs: timestamp, input preview, status (success/error), duration
  - Click → expand inline, показывает full input/output

**Empty state:** "Нет code-tools. Создай первый: [+ New]" → opens skeleton editor

## Mock data needed

- `plugins` (5 plugins: 3 enabled, 1 disabled, 1 with error status)
- `mcpTools` (12 tools: mix scope public/agent-only, разные input schemas)
- `codeTools` (4 tools с realistic JS code 30-50 lines each)
- `codeToolRuns` (5-10 runs per tool)

## Components чек-лист

- [ ] Tab navigation (3 tabs)
- [ ] Plugin grid с status indicators, toggle switches
- [ ] Plugin hooks detail modal
- [ ] MCP tool list + detail panel + dynamic form generated from JSON schema
- [ ] MCP tool tester с execute button + result panel
- [ ] Code-tool list + main editor area + sandbox runner + run history
- [ ] Mock syntax highlighting через regex CSS classes
- [ ] Editable inline tool name/description
- [ ] Empty states

## Acceptance criteria

- [ ] HTML ≤600 строк
- [ ] All 3 tabs работают
- [ ] Plugin enable/disable toggle с визуальным feedback (animated switch)
- [ ] MCP tester form-generation: для одного tool с input schema (memory_search например — query string + layer enum) форма генерируется правильно
- [ ] MCP tester [Execute]: показывает skeleton 800ms → result success с mock JSON output
- [ ] Code editor textarea+pre overlay: user может type, текст показывается с подсветкой (basic regex mock — keywords/strings/comments/numbers)
- [ ] Sandbox runner: [Run in sandbox] показывает skeleton → mock output с тeming badge
- [ ] Mobile: plugin grid stack, MCP tool list-only с push для detail, code-tool sidebar drawer

## Notes

- Mock syntax highlighter: использовать `<span class="syn-keyword">function</span>`-style либо regex CSS pseudo-elements. Простой подход: при render заменить regex matches на wrapped spans.
- Code editor "live edit feel": textarea с цветом transparent text + пересоздание `<pre>` каждый input event. Производительность не критична (мок).
- Form-generator из JSON schema: 5 типов (string, integer, boolean, enum, object). Object — collapsed по default.
- Plugin "configure" modal — pre-fill с mock JSON config, не настоящие settings.
