# Task 00 — Design System Foundation

> Это первый и обязательный пакет. Всё остальное (01-08) зависит от artifact'ов созданных здесь. Не делать функциональные блоки до этого.

## Read first

- [`../00-master-spec.md`](../00-master-spec.md) — общий контекст, эстетика, все hard constraints

## Goal

Создать design system foundation для Subbrain Web Rewrite моков:

- CSS design tokens (цвета, типография, spacing, radii, shadows, transitions)
- Base styles (reset, typography defaults, body, scrollbar)
- Reusable component classes (button, input, card, badge, modal, toast, list-row, tab, palette, drawer, sparkline, skeleton, empty-state)
- Vanilla JS utilities (tab-switcher, modal-toggle, list-filter, command-palette, toast-trigger)
- Mock data shape (chats, memory, tasks, projects, agents, leads, plugins, tools, runs, approvals, telegram chats)
- Index lobby HTML

После этого таска — все 8 функциональных страниц могут быть собраны независимо, опираясь на готовые tokens и компоненты.

## Output structure

```
docs/design/p7-mockups/
├─ index.html                          # лобби со списком 8 функциональных блоков
└─ shared/
   ├─ tokens.css                       # CSS variables
   ├─ base.css                         # reset, typography, body
   ├─ components.css                   # переиспользуемые классы
   ├─ icons.svg                        # Lucide sprite или document с inline SVG'шками
   ├─ mock-data.js                     # все mock-объекты экспортами
   └─ utils.js                         # vanilla helpers
```

## Detailed requirements

### `shared/tokens.css`

CSS variables, доступны всем потребителям. Группировка комментариями.

**Цвета (только dark theme):**

```css
:root {
  --color-bg: #0F0F0F;                  /* основной фон */
  --color-surface-1: #171717;           /* cards, modals base */
  --color-surface-2: #1F1F1F;           /* elevated, hover */
  --color-border: #2A2A2A;              /* dividers, тонкие 1px */
  --color-border-strong: #3A3A3A;       /* outline focused secondary */

  --color-text-primary: #EDEDED;
  --color-text-secondary: #A0A0A0;
  --color-text-tertiary: #666666;

  --color-accent: #C96442;              /* terracotta — единственный accent */
  --color-accent-hover: #D67450;
  --color-accent-active: #B45838;
  --color-accent-text: #FFFFFF;         /* текст на accent-фоне */

  --color-success: #3FB950;
  --color-warn:    #D29922;
  --color-danger:  #F85149;
  --color-info:    #58A6FF;
}
```

**Типография:**

```css
:root {
  --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
  --font-mono: 'Geist Mono', 'JetBrains Mono', 'Menlo', monospace;

  --fs-xs:  12px;
  --fs-sm:  14px;
  --fs-md:  16px;
  --fs-lg:  20px;   /* mobile h2, desktop h2 = 22px */
  --fs-xl:  28px;   /* mobile h1, desktop h1 = 32px */

  --fw-regular:  400;
  --fw-medium:   500;
  --fw-semibold: 600;

  --lh-body:    1.5;
  --lh-heading: 1.3;
  --lh-control: 1.4;

  --tracking-tight: -0.01em;
  --tracking-normal: 0;
}

@media (min-width: 768px) {
  :root {
    --fs-lg: 22px;
    --fs-xl: 32px;
  }
}
```

Загрузка Inter и Geist Mono через `<link>` с Google Fonts или [vercel.com/font](https://vercel.com/font) в `<head>` каждого HTML-файла. Если нет интернета у Claude Code — fallback на `system-ui`.

**Spacing (8px base):**

```css
:root {
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-6: 24px;
  --space-8: 32px;
  --space-12: 48px;
  --space-16: 64px;
}
```

**Radii:**

```css
:root {
  --radius-sm: 4px;     /* inputs, buttons, cards */
  --radius-md: 6px;     /* modals, command palette */
  --radius-pill: 999px; /* badges */
}
```

**Shadows и transitions:**

```css
:root {
  --shadow-sm: 0 1px 2px rgba(0,0,0,0.4);
  --shadow-md: 0 4px 12px rgba(0,0,0,0.5);
  --shadow-lg: 0 12px 32px rgba(0,0,0,0.6);

  --transition-fast: 120ms cubic-bezier(0.4, 0, 0.2, 1);
  --transition-base: 200ms cubic-bezier(0.4, 0, 0.2, 1);
  --transition-slow: 320ms cubic-bezier(0.4, 0, 0.2, 1);

  --focus-ring: 0 0 0 2px var(--color-accent);
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition: none !important; animation: none !important; }
}
```

### `shared/base.css`

- Modern reset (Josh Comeau style или подобный): `* { box-sizing: border-box; margin: 0 }`, `html { -webkit-text-size-adjust: 100% }`, etc.
- `html`: `font-size: 16px`.
- `body`: `font-family: var(--font-sans)`, `font-size: var(--fs-md)`, `line-height: var(--lh-body)`, `color: var(--color-text-primary)`, `background: var(--color-bg)`, `-webkit-font-smoothing: antialiased`.
- `h1-h6`: соответствующие `--fs-xl` / `--fs-lg` / `--fs-md`, `--fw-semibold`, `--lh-heading`, `--tracking-tight`.
- `code, pre, kbd`: `var(--font-mono)`, `font-feature-settings: 'liga' 0, 'calt' 0`.
- Custom scrollbar: тонкий, цвета из tokens, на webkit и firefox.
- `:focus-visible`: использует `--focus-ring`.
- Skip-to-main link (visually-hidden до focus).
- `[hidden]`: `display: none !important`.

### `shared/components.css`

Reusable классы с BEM-like неймингом. Список обязательных (можно добавлять при необходимости):

**Buttons:**
- `.btn` — base styles (padding, radius, font, transition)
- `.btn--primary` — accent background
- `.btn--secondary` — surface-1 background, border
- `.btn--ghost` — transparent, hover surface-1
- `.btn--danger` — danger color
- `.btn--icon` — icon-only, square
- Sizes: `.btn--sm` (32px), `.btn--md` (40px default), `.btn--lg` (48px) — все ≥44px hit-target на mobile

**Inputs:**
- `.input` — base text input
- `.input--sm`, `.input--lg`
- `.textarea` — multiline
- `.select` — styled native select
- `.checkbox`, `.radio`, `.switch` — кастомные styled controls
- `:focus-visible` — `--focus-ring`

**Cards:**
- `.card` — surface-1, padding 24px (16px на mobile), radius-sm
- `.card--elevated` — surface-2, shadow-sm
- `.card--interactive` — hover surface-2, cursor pointer

**Badges:**
- `.badge` — pill-shape, font-mono, padding 4px 8px, fs-xs
- `.badge--success`, `.badge--warn`, `.badge--danger`, `.badge--info`, `.badge--neutral` — semantic
- `.badge--accent` — accent variant

**List rows:**
- `.list-row` — flex layout, padding 12px 16px, hover surface-1, border-bottom тонкий
- `.list-row--active` — accent left border 2px
- `.list-row__primary`, `.list-row__secondary`, `.list-row__meta` — структура внутри

**Tabs:**
- `.tabs` — wrapper
- `.tabs__list` — flex row, border-bottom
- `.tabs__trigger` — single tab button, padding 8px 16px
- `.tabs__trigger--active` — accent underline 2px, accent text
- `.tabs__panel` — content area, padding 24px

**Modals:**
- `.modal-backdrop` — fixed overlay, rgba(0,0,0,0.7), backdrop-filter blur 8px
- `.modal` — centered, surface-1, radius-md, max-width 560px desktop / full-screen mobile
- `.modal__header`, `.modal__body`, `.modal__footer`
- `[role="dialog"]` ARIA wiring
- Animation: fade-in 200ms

**Drawer (mobile sidebar):**
- `.drawer` — fixed left, surface-1, width 280px, slide-in transition
- `.drawer-backdrop` — overlay
- Toggle через JS

**Command Palette:**
- `.palette-backdrop`
- `.palette` — top-center, surface-2, radius-md, max-width 600px
- `.palette__input` — searchbar
- `.palette__list` — results
- `.palette__item` — single result, hover accent bg
- `.palette__item--selected` — keyboard nav

**Toast:**
- `.toast` — fixed top-right desktop / bottom mobile, surface-2, radius-sm, padding 12px 16px
- `.toast--success`, `.toast--warn`, `.toast--danger`, `.toast--info`
- Animation slide-in-from-right (desktop) / from-bottom (mobile)
- Auto-dismiss 4s, manual close X button

**Sparkline:**
- `.sparkline` — inline SVG container, fixed height 32px, width fluid
- Path styling (stroke accent, fill rgba(accent, 0.1))

**Skeleton:**
- `.skeleton` — shimmer animation, surface-2, radius-sm
- `.skeleton-row`, `.skeleton-line`, `.skeleton-circle` — варианты

**Empty state:**
- `.empty-state` — centered flex, padding 48px
- `.empty-state__icon` — Lucide outline 32px tertiary color
- `.empty-state__title` — h3, fs-lg, fw-semibold
- `.empty-state__description` — fs-sm secondary text
- `.empty-state__action` — primary button

**Layout helpers:**
- `.container` — max-width 1200px, mx auto, padding-x responsive
- `.stack` — vertical flex с gap (modifier classes для spacing)
- `.cluster` — horizontal flex с wrap и gap
- `.divider` — thin horizontal line

### `shared/icons.svg`

Lucide outline SVG sprite. Минимально нужны иконки:

`menu`, `x` (close), `search`, `plus`, `chevron-down`, `chevron-right`, `chevron-left`, `arrow-right`, `check`, `clock`, `play`, `pause`, `square` (stop), `trash`, `pencil`, `archive`, `link`, `external-link`, `message-circle`, `brain` (memory), `users` (agents), `list-todo` (tasks), `folder` (projects), `shield-check` (control), `puzzle` (extend), `bar-chart` (observe), `network` (connections), `settings`, `terminal` (operations), `bell` (notifications), `more-vertical`, `pin`, `filter`, `sliders` (controls), `command` (palette icon).

Format: один `icons.svg` файл с `<symbol id="icon-name">` элементами. Использование: `<svg><use href="shared/icons.svg#icon-search"/></svg>`.

Если sprite-формат сложен, fallback: inline SVG-строки в `mock-data.js` как exports.

### `shared/mock-data.js`

ES module exports со всеми мок-данными. Реалистичные значения, разнообразные. Структура:

```js
export const chats = [/* 12+ chat objects */];
export const memoryShared = [/* 20+ entries */];
export const memoryContext = [/* 15+ entries */];
export const memoryArchive = [/* 10+ entries */];
export const memoryFocus = [/* 5-7 entries */];
export const memoryAgent = [/* 8+ entries */];
export const memoryEdges = [/* 30+ edges */];
export const memoryPending = [/* 5 entries with confidence < 0.8 */];

export const tasks = [/* 30+ tasks: mix scope=default & agent scopes */];
export const projects = [/* 5 projects with varying status */];
export const taskTimers = [/* current running + history */];

export const agents = {
  pool: [/* 5 active runs */],
  history: [/* 15 past runs */],
  schedulers: { autonomous: {...}, freeAgent: {...}, freelanceScout: {...} },
  a2aRooms: [/* 3 rooms, one with full transcript */],
};

export const leads = [/* 10 freelance leads */];
export const plugins = [/* 5 plugins */];
export const mcpTools = [/* 12 tools */];
export const codeTools = [/* 4 code-tools */];

export const approvals = {
  pending: [/* 5 */],
  audit: [/* 20 historical decisions */],
};

export const observability = {
  costToday: {/* total, by-model breakdown */},
  costSparkline: [/* hourly array */],
  runs: [/* 10 traces */],
  logs: [/* 50 log entries */],
  health: {/* providers, schedulers, backup */},
};

export const telegramChats = [/* 8-10 chats */];
export const integrations = [/* 4 placeholders */];

export const operations = {
  nightCycle: {/* status + 7-run history */},
  backup: {/* status + history */},
  systemInfo: {/* version, uptime, memory */},
};

// Utilities
export const now = () => Date.now();
export const minutesAgo = (n) => Date.now() - n * 60_000;
export const hoursAgo = (n) => Date.now() - n * 3600_000;
export const daysAgo = (n) => Date.now() - n * 86400_000;
```

Каждый объект имеет минимум: `id`, `created_at`, основные поля по domain. Realistic content (русский где имеет смысл — chat-content, task titles; английский для tech-полей).

### `shared/utils.js`

Vanilla JS helpers, без зависимостей. ES module exports:

```js
// Tab switcher: data-tabs attribute, data-tab="name" triggers, data-panel="name" panels
export function initTabs(rootSelector = '[data-tabs]') { ... }

// Modal toggle: data-modal-trigger="id" opens, data-modal-close closes
export function initModals() { ... }

// Drawer (mobile sidebar): data-drawer-trigger
export function initDrawer() { ... }

// List filter: data-filter-input + data-filter-target
export function initFilters() { ... }

// Command palette: Cmd+K / Ctrl+K opens, search filters from getCommands()
export function initCommandPalette(getCommands) { ... }

// Toast: programmatic API
export function showToast({ message, variant = 'info', duration = 4000 }) { ... }

// Skeleton: hide когда data ready
export function hideSkeleton(selector) { ... }

// Pseudo-streaming: types out text по символу через setInterval
export function pseudoStream(element, text, charsPerTick = 2, tickMs = 30) { ... }

// Template clone helper
export function renderList({ templateId, targetSelector, items, populate }) { ... }
```

Все helpers — exports с JSDoc. Никаких глобальных переменных, никаких side-effects при импорте.

### `index.html`

Лобби. Структура:

- `<header>` с системным статусом (mock: "v0.1.0 • uptime 3д 4ч • status ok").
- `<main>` с grid карточек (8 функциональных блоков). Каждая карточка:
  - Иконка (Lucide outline)
  - Title (название блока, например «Разговор и память»)
  - 2-line description
  - Стрелка accent-color «→»
  - `<a>` обёртка → ведёт на соответствующий HTML файл
- Hover: surface-2 background, accent stroke на стрелке.
- Mobile: одна колонка, на desktop — 2-3 колонки.
- `<footer>` с минималистичной ссылкой "Design system v0 • Subbrain Web P7 mockups".

В шапке HTML:
- `<link>` на `shared/tokens.css`, `shared/base.css`, `shared/components.css`
- `<script type="module">` на `shared/utils.js` если нужны interaction (для hover-effects можно чисто CSS).
- Inter и Geist Mono fonts.

8 карточек, в порядке:
1. **A — Разговор и память** → `A-talk-and-remember.html`
2. **B — Делегирование и автономная работа** → `B-delegate-and-autonomous.html`
3. **C — Задачи и проекты** → `C-tasks-and-projects.html`
4. **D — Контроль и доверие** → `D-control-and-trust.html`
5. **E — Расширение и кастомизация** → `E-extend-and-customize.html`
6. **F — Наблюдение и отладка** → `F-observe-and-debug.html`
7. **G — Связность и интеграции** → `G-connections-and-integrations.html`
8. **H — Операции и housekeeping** → `H-operations-and-housekeeping.html`

## Acceptance criteria

- [ ] `index.html` открывается в браузере, отображает 8 карточек, hover-states работают.
- [ ] `tokens.css` использует только CSS variables, никаких magic numbers.
- [ ] `base.css` применяет reset + body styles, типографика консистентна.
- [ ] `components.css` имеет все классы из списка, каждый с hover/focus/active/disabled states.
- [ ] `mock-data.js` ES module, импортируется в `<script type="module">`, все exports доступны.
- [ ] `utils.js` — все helpers экспортированы, без globals.
- [ ] Контраст текста к фону: тестовый замер для primary text против `--color-bg` ≥ 7:1, для secondary ≥ 4.5:1.
- [ ] `prefers-reduced-motion` отключает анимации.
- [ ] Hit-target всех buttons/inputs на mobile ≥ 44×44px.
- [ ] `:focus-visible` показывает 2px accent ring на каждом интерактивном элементе.
- [ ] Skip-to-main link присутствует и работает (Tab от начала фокусит его).
- [ ] Semantic HTML: `<header>`, `<main>`, `<nav>`, `<footer>` где уместно.

## Notes

- Используй Lucide иконки через свой clone из npm если есть доступ, иначе скопируй нужные SVG паттерны вручную.
- Если font-loading не работает offline — graceful fallback на `system-ui`.
- НЕ начинай функциональные блоки (01-08) до того как этот пакет утверждён юзером.
