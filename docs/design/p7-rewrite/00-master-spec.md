# Subbrain Web Rewrite — Master Design Spec v3

> Финальная версия общего брифа. Это **дизайн-задача**, не имплементация. Output — статические HTML/CSS-моки с минимальным vanilla JS. Позже отдельной волной портируется в Nuxt 4 + Vue 3 + @nuxt/ui.

## 1. Цель и формат delivery

Получить от Claude Code набор статических веб-страниц-моков, который описывает как должен выглядеть и ощущаться будущий Subbrain UI. Каждая функциональная группа = отдельный HTML-файл с реалистичными мок-данными, продуманной типографикой, цветовой схемой, отступами, hover/focus-стейтами и базовым interaction layer (табы, модалки, фильтры, command palette). Открыть в браузере — увидеть как продукт работает, без бэкенда и Vue.

Backend roadmap идёт отдельным документом ([`backend-roadmap.md`](./backend-roadmap.md)) — дизайн ведёт, бэкенд догоняет. Если фича в дизайне отсутствует в API сейчас — ничего страшного, бэкенд добавит когда дизайн утверждён.

После аппрува визуала:

- Мок выбрасывается, остаются design tokens (цвета, типография, spacing scale).
- Tokens переносятся в Tailwind config + @nuxt/ui theme overrides.
- Каждый функциональный экран реимплементируется как Vue-страница с реальными composables/SSE/API.

Формат для текущей задачи:

- Pure HTML5 + CSS3 + vanilla JavaScript. Без сборки, без npm-зависимостей, без bundlers. Открыть `index.html` в браузере — всё работает.
- Один shared stylesheet с design tokens, один с компонент-классами, один base.
- Каждая функциональная группа — отдельный HTML-файл.
- Realistic mock data в отдельном `.js`-файле в виде объектов. Никаких настоящих API-вызовов.
- Vanilla JS только для UX-интерактивности: переключение табов, модалки, hover/focus, client-side фильтрация, темплейт-driven рендер из мок-массива, command palette с поиском.
- Vanilla `<template>` element + JS clone+populate для повторяющихся записей. `innerHTML` со string-concat запрещён даже на mock-data.

## 2. Контекст

Subbrain — персональный AI-ассистент с долгосрочной памятью, агентскими циклами и встроенными интеграциями. Один владелец, иногда — пользователи через Telegram-бот. Бэкенд: Bun + Elysia + SQLite + hybrid RAG (FTS5 + sqlite-vec + rerank), маршрутизатор по нескольким LLM-провайдерам (NVIDIA NIM, MiniMax, OpenRouter), MCP tool ecosystem.

Существующий веб — Nuxt 4, четыре страницы (chat, memory, tasks, freelance), архитектурно чистый, но IA по бэкенд-модулям. Параллельно идёт Wave 2/3: agent pool, A2A-комнаты, plugin runtime, approval-flow с Telegram-bridge, бэкап, PII, bi-temporal memory. Дизайн закладывает место под это.

## 3. Эстетика и стиль

### Референс — Anthropic

Вдохновение: claude.ai, Anthropic console, документация Anthropic.

**Типографика и цвет — Anthropic-style:**
- Один primary sans с настоящим мульти-вес ассортиментом: **Inter** (regular 400, medium 500, semibold 600). Используем реальные веса, не CSS `font-weight: bold` через synthesis.
- Один mono для кода, ID, JSON: **Geist Mono** или **JetBrains Mono**.
- Type scale пять ступеней: `12 / 14 / 16 / 20 / 28` px (mobile baseline) → `12 / 14 / 16 / 22 / 32` (desktop). Никаких 8 размеров шрифта.
- Line-height просторный: 1.5 для body, 1.3 для headings, 1.4 для UI controls.
- Tracking чуть отрицательный для крупного (-0.01em для h1-h2), нейтральный для остального.
- Семантика через вес и размер, не через цвет. Заголовок не «синий жирный», а «крупный medium».

**Цветовая палитра (только dark):**
- Фон: глубокий not-quite-black `#0F0F0F` (приглушённый, не #000).
- Surface elevated (cards, modals): `#171717` → `#1F1F1F` 2 уровня elevation.
- Borders/dividers: `#2A2A2A` (тонкие 1px), используются только когда абсолютно необходимы.
- Text primary: `#EDEDED` (тёплый off-white).
- Text secondary: `#A0A0A0`.
- Text tertiary: `#666666`.
- **Accent — один и единственный**: terracotta/burnt-orange в Anthropic-духе. Финал: `#C96442`. Используется для primary action button background, focus ring, активного таба, ссылок в тексте. Никаких других акцентных цветов.
- Semantic: success `#3FB950`, warn `#D29922`, danger `#F85149`, info `#58A6FF` — но используются ТОЛЬКО для status badges и нотификаций, не для UI accent.

**Density — Notion-spacious:**
- Spacing scale на 8px base: `4 / 8 / 12 / 16 / 24 / 32 / 48 / 64`. Никаких 7px, 11px, 25px.
- Sections разделены тишиной (margin/padding), не линиями.
- Cards имеют padding минимум 24px на desktop, 16px на mobile.
- Между UI-блоками минимум 32px пустоты.

Если возникает напряжение «Anthropic = плотные таблицы в console vs Notion-spacious» — решение зафиксировано: **typography и color = Anthropic, spacing density = Notion**. Эти axes независимы.

**Скруглений минимум:**
- 4px на inputs, buttons, cards.
- 6px на modals, command palette.
- Pill-shape только для badges (status, tags).
- Ничего более скруглённого, никаких bubble-UI.

**Состояния:**
- Hover: тонкий shift фона на 1-2 ступени по серой шкале (`#171717` → `#1F1F1F`). Никаких drop-shadow.
- Focus: 2px ring цвета accent, всегда видимый. Доступность не опционна.
- Active: pressed-down через background, не transform.
- Disabled: opacity 0.4, cursor not-allowed.

**Иконки:**
- **Lucide** outline, 1.5px stroke, 16px/20px/24px размеры.
- Inline SVG в HTML или SVG sprite. Без icon font.

**Принципы хорошей вёрстки** (применяются без напоминаний):
- Vertical rhythm соблюдается, baseline alignment сохраняется при разных размерах текста.
- Контраст текста к фону минимум 7:1 для body, 4.5:1 для secondary.
- Никаких magic numbers в CSS — только design tokens через CSS variables.
- Hit-target на mobile минимум 44×44px.
- `prefers-reduced-motion` отключает анимации.
- Semantic HTML: `<main>`, `<nav>`, `<aside>`, `<article>`, корректные heading levels.
- ARIA-метки на интерактивных элементах без видимого текста.
- Skip-to-main link для клавиатурной навигации.

## 4. Hard constraints

**Тема — только dark mode.** Light variant не делаем.

**Mobile-first.** Дизайн начинается с 375px и масштабируется вверх. Каждый ключевой flow должен быть полнофункциональным на телефоне. Десктоп — расширенная версия мобильного, не наоборот.

**Heavy views на mobile** — для каждого тяжёлого экрана прописан явный fallback:
- Pool monitor: на mobile только активные карточки без графиков rate-limit, табы вместо колонок.
- A2A conversation tree: на mobile линейный thread с indent-маркерами вместо tree-view.
- Run trace viewer: на mobile timeline-only (без tree), drill в step переходом на новый экран.
- Cost dashboard: на mobile только сегодняшний день sparklines, drill в неделю/месяц по тапу.
- Memory graph: на mobile упрощённый radial layout (центральная нода + соседи), pan через touch.

**Долгосрочные ограничения** (для будущего порта в Nuxt):
- Bun runtime, Nuxt 4 SSR, composables-only state.
- Bearer auth через `/api/token`.
- SSE как доминирующий live-update канал.
- Self-hosted single-user, без onboarding.
- @nuxt/ui v4 utility-classes mindset → дизайн опирается на utility-первый подход.

## 5. Функциональные группы

Каждая группа — один HTML-файл. Подробные task-файлы в [`tasks/`](./tasks/).

- **A. Разговор и память** (`A-talk-and-remember.html`) — chat + streaming + memory drill-in + graph + pending + bi-temporal. См. [`tasks/01-talk-and-remember.md`](./tasks/01-talk-and-remember.md).
- **B. Делегирование и автономная работа** (`B-delegate-and-autonomous.html`) — task launcher + pool monitor + schedulers + A2A rooms. См. [`tasks/02-delegate-and-autonomous.md`](./tasks/02-delegate-and-autonomous.md).
- **C. Задачи и проекты** (`C-tasks-and-projects.html`) — 4 таба, 2 пула (для агентов / мои), projects registry, auto-tracker. См. [`tasks/03-tasks-and-projects.md`](./tasks/03-tasks-and-projects.md).
- **D. Контроль и доверие** (`D-control-and-trust.html`) — approval inbox, audit, memory rollback, confidence tuner. См. [`tasks/04-control-and-trust.md`](./tasks/04-control-and-trust.md).
- **E. Расширение и кастомизация** (`E-extend-and-customize.html`) — plugins, MCP browser, code-tool editor. См. [`tasks/05-extend-and-customize.md`](./tasks/05-extend-and-customize.md).
- **F. Наблюдение и отладка** (`F-observe-and-debug.html`) — cost/latency dashboard, run trace, logs explorer, health. См. [`tasks/06-observe-and-debug.md`](./tasks/06-observe-and-debug.md).
- **G. Связность и интеграции** (`G-connections-and-integrations.html`) — Telegram chats, integrations registry, webhooks. См. [`tasks/07-connections-and-integrations.md`](./tasks/07-connections-and-integrations.md).
- **H. Операции** (`H-operations-and-housekeeping.html`) — night cycle, backup, settings, system status. См. [`tasks/08-operations-and-housekeeping.md`](./tasks/08-operations-and-housekeeping.md).

Foundation (design system, base styles, components, mock-data shape, lobby) — отдельный обязательный первый пакет: [`tasks/00-foundation.md`](./tasks/00-foundation.md).

## 6. Cross-cutting concerns

**Command palette (Cmd-K / Ctrl-K).** Глобальный, доступен с любой страницы. Команды:
- New chat / New task / New project
- Search memory / Search chats / Search tasks
- Run night cycle / Trigger backup
- Toggle agent: autonomous / free-agent / scout (start/stop)
- Recent items (последние 5 чатов/задач/memory entries)
- Jump to: A/B/C/D/E/F/G/H страницам

Recent items сверху, fuzzy-match. В моке функциональный через JS event listener (Cmd+K) и фильтрацию массива команд.

**Mobile вёрстка.**
- Sidebar = drawer (slide from left, hamburger trigger в header).
- Modal'ы = full-screen на mobile (375-640px), centered dialog на desktop.
- Quick-add task достижима с любой страницы одним thumb-tap (FAB-like button bottom-right на mobile, в command palette на desktop).
- Bottom-sheet используется только для quick-actions (не для full UI).

**Real-time показывается живым:**
- Псевдо-стриминг через `setInterval`: chat — символы появляются, agent-loop — шаги добавляются, новые approvals/leads — fade-in в списке.
- Pulse на активных элементах (running agent step, currently-tracking task).
- В продакшене это будет SSE.

**Empty states.** Каждый пустой список/панель — продуманное сообщение с CTA, не белая дыра. Шаблон: иконка (Lucide outline 32px, tertiary color) + h3 заголовок + описание 1-2 строки + primary action button (если есть). Стандартизировать в `components.css`.

**Error states.** Конкретный текст и actionable next step:
- 429 rate-limit от провайдера: «Превышен лимит {provider}. Возобновится через {time}. Переключиться на fallback?»
- Network error: «Сервер не отвечает. Проверь соединение или повтори.»
- Broken task / malformed response: «Что-то сломалось при {action}. Полный лог: [link]».

**Skeleton-loading.** Только для desktop tables/lists с потенциально ≥10 строк. Mobile = сразу-данные или single spinner. Skeleton — серые плейсхолдеры точного размера будущих строк, animated shimmer.

**Toast/notification system.**
- Trigger: после mutation success/error.
- Position: top-right на desktop, bottom на mobile.
- Auto-dismiss 4s, manual close X-button.
- Stacking: max 3 одновременно, FIFO.
- Variants: success / warn / danger / info — с semantic-цветом из палитры.

## 7. Deliverable structure

```
docs/design/p7-mockups/
├─ index.html                          # Лобби со списком функциональных блоков, описаниями, accent-стрелками
├─ shared/
│   ├─ tokens.css                      # CSS variables: цвета, типография, spacing, radii, shadows, transitions
│   ├─ base.css                        # reset, body, base typography, forms reset, scrollbar
│   ├─ components.css                  # button, input, card, badge, modal, toast, list-row, tab, palette, drawer, sparkline, skeleton, empty-state
│   ├─ icons.svg                       # Lucide sprite-sheet или inline в HTML
│   ├─ mock-data.js                    # все mock-объекты (chats, memory, tasks, projects, agents, leads, plugins, tools, runs, approvals, telegram chats)
│   └─ utils.js                        # vanilla helpers: tab-switcher, modal-toggle, list-filter, command-palette, theme (NO-OP since dark only), toast-trigger, skeleton-show
├─ A-talk-and-remember.html
├─ B-delegate-and-autonomous.html
├─ C-tasks-and-projects.html
├─ D-control-and-trust.html
├─ E-extend-and-customize.html
├─ F-observe-and-debug.html
├─ G-connections-and-integrations.html
├─ H-operations-and-housekeeping.html
└─ DESIGN-NOTES.md                     # 1000-1500 слов: rationale, alternatives, mapping tokens → Tailwind
```

**Размер:** каждый mock HTML — 400-600 строк, включая mock-data references из shared/mock-data.js.

**`index.html` лобби:** карточки 8 функциональных блоков, у каждой — название + 2-line описание + accent-color стрелка. Шапка с системным статусом (uptime, version) для общего ощущения «приложение, не landing».

**`DESIGN-NOTES.md` (1000-1500 слов, обязателен):**
- Цветовая палитра: почему именно эти hex, как accent работает с background.
- Типографика: почему Inter, почему такая type-scale, line-height обоснование.
- Density: почему 8px base, почему такие card-padding.
- Структура Tasks: обоснование 4 таба + 2 пула + projects registry.
- Mobile-fallback решения для тяжёлых views.
- Mapping таблица design tokens → Tailwind utility classes для будущего порта в Nuxt.
- Alternatives: что отсмотрели и почему отказались.

## 8. Зафиксированные решения

- **Эстетика:** Anthropic typography/color (Inter, terracotta accent `#C96442`, monochrome dark) + Notion spacing density (8px base, generous padding).
- **Density:** максимально просто, Notion-spacious, не Linear-cramped.
- **Tasks:** 4 таба (Актуальные / Для агентов / Мои / Проекты), 2 пула (агенты vs мои-by-project), projects registry отдельно. Auto-tracker простой (start/stop + pinned auto-track).
- **Theme:** только dark mode.
- **Command palette:** must-have v1, специфичные команды перечислены.
- **Mobile:** mobile-first, desktop = expanded mobile. Heavy views имеют явные mobile-fallback.
- **A2A:** включается сразу, не deferred.
- **Memory edges:** graph view (canvas/SVG, без real graph lib).
- **Approval inbox:** mirror TG-channel, action sync обоюдная.
- **Recurring:** preset selector + custom cron placeholder.
- **Auto-tracker location:** header (desktop) / footer (mobile) + full panel в Актуальные.
- **Bi-temporal:** simple date picker.
- **Sidebar mobile:** drawer (slide from left).
- **Templates:** vanilla `<template>` element + clone.
- **Toasts:** top-right desktop / bottom mobile, 4s auto-dismiss.
- **Все 8 блоков** делаем (не deferred).
- **Free-agent per-chat:** demo с note (backend addition required).
- **Onboarding/logo/username:** не делаем, single-user.
