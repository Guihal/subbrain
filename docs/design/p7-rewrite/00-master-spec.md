# Subbrain Web Rewrite — Master Design Spec v3

> Финальная версия общего брифа. Это **дизайн-задача**, не имплементация. Output — статические HTML/CSS-моки с минимальным vanilla JS. Позже отдельной волной портируется в Nuxt 4 + Vue 3 + @nuxt/ui.

## 1. Цель и формат delivery

Получить от Claude Code набор статических веб-страниц-моков, который описывает как должен выглядеть и ощущаться будущий Subbrain UI. Каждая функциональная группа = отдельный HTML-файл с реалистичными мок-данными, продуманной типографикой, цветовой схемой, отступами, hover/focus-стейтами и базовым interaction layer (табы, модалки, фильтры, command palette). Открыть в браузере — увидеть как продукт работает, без бэкенда и Vue.

Backend roadmap идёт отдельным документом — дизайн ведёт, бэкенд догоняет. Если фича в дизайне отсутствует в API сейчас — ничего страшного, бэкенд добавит когда дизайн утверждён.

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

Вдохновение: claude.ai, Anthropic console, документация Anthropic. Это значит:

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

Каждая группа — один HTML-файл. Внутри могут быть табы/секции/модалки.

### A. Разговор и память (`A-talk-and-remember.html`)

Главный режим — диалог, в котором система отвечает и автоматически извлекает факты в слоистую долгосрочную память (focus, shared, context, archive, agent, log) и связывает их рёбрами в графе.

**Flow:** ведёт разговор с любой из виртуальных моделей (teamlead, coder, critic, generalist, chaos, flash, memory). Streaming-ответ с раскрываемым reasoning-блоком, остановка генерации, переключение между чатами в боковой панели. Параллельно — превью памяти которая прямо сейчас будет извлечена из текущего exchange (candidate-факты до записи). Drill в полную memory-админку: split view на desktop, push-navigation на mobile.

**Memory админка:** единый поиск по всем слоям, фильтры по конкретному, edit в-place. **Граф связей** одной записи — простая force-directed визуализация на canvas/SVG (без подключения cytoscape/d3 — нарисованная вручную сетка с draggable nodes, 8-15 нод, разные shape для разных layer'ов, толщина edges по weight'у связи). Pending-инбокс с массовыми approve/reject. Bi-temporal date picker — простой calendar input с jump-to-today, при выборе даты записи фильтруются на момент `valid_at <= selected`.

**Key components mock'а:** chat-thread с 5-7 сообщениями (один с активным streaming-симулятором через `setInterval`), sidebar с историей 10+ чатов, command palette (Cmd-K) с глобальным поиском, memory-modal с табами и graph-canvas, pending-инбокс с 5 entry, candidate-extraction preview ниже текущего exchange.

### B. Делегирование и автономная работа (`B-delegate-and-autonomous.html`)

Subbrain имеет несколько автономных контуров: autonomous loop, free agent, freelance scout. Wave 2 добавит agent pool. A2A-комнаты — синтез мнений нескольких специалистов.

**Flow:** ввёл цель, выбрал модель/role/budget steps, опционально scope, запустил, видишь live-стрим шагов с tool-вызовами, memory_write, partial-ответами. Stop, full trace через OTel-spans, copy-prompt в новый чат.

**Pool monitor:** текущая очередь, активные с прогресс-индикаторами, rate-limit usage по провайдерам (bar по каждому), история запусков с фильтрами и ссылками в трейсы.

**Schedulers (free-agent, scout):** панели со статусом (running/paused/last-error/next-tick), start/stop, последние находки (для scout — лиды с budget/category/source, для free-agent — TG-дайджесты), edit конфигурации (interval, budget, categories) inline без модалок.

**Free-agent per-chat scope** в моке demo (UI showing chat selector). В DESIGN-NOTES помечено: *requires backend addition в free-agent.ts: FREE_AGENT_TG_CHATS=multi*.

**A2A-комнаты** включены сразу. Visual: conversation tree где у корня — задача, листья — финальный синтез, между ними — раунды специалистов. На desktop — проводник-style tree в левой колонке + детали в правой. На mobile — линейный thread с indent-уровнями и role-badges (teamlead / coder / critic), tap для drill в полный response каждого участника.

**Key components mock'а:** task-launcher form, live-стрим работающего агента (псевдо-стрим через JS), pool dashboard с 5+ симулированными активными, scheduler-карточки с inline-config, A2A transcript для одной завершённой комнаты с 3 раундами.

### C. Задачи и проекты (`C-tasks-and-projects.html`)

Центральная страница согласно резолюциям. Структура — четыре таба, два логических пула, отдельный registry проектов.

**Tab 1 — «Актуальные»**: cross-pool top-of-mind. Объединённый рабочий вид: in_progress + overdue + due_today + due_this_week, всё что требует внимания сейчас. Source-agnostic — сюда падают и личные, и project-attached, и autonomous-сгенерированные. Первый экран при открытии Tasks. Сортировка по приоритету и дедлайну. Карточки/строки с pool-индикатором (badge «agent» или название проекта).

**Tab 2 — «Для агентов»** (Pool 1): задачи которые я ставлю агентам или агенты сами создают для себя. Backend scope: autonomous, free-agent, freelance, tg. Группировка по scope. Quick-add сверху с выбором scope. Фильтры (active/done/cancelled), сортировка. Возможность ткнуть «передать активному агенту прямо сейчас» (если pool есть).

**Tab 3 — «Мои»** (Pool 2): личные задачи, group-by project. Selector проекта сверху (или «без проекта»). Внутри выбранного проекта — flat list задач, можно добавить новую сразу attached. Если выбрано «без проекта» — задачи без `project_id`. Инлайн edit, отметить done одним тапом, переназначить приоритет drag.

**Tab 4 — «Проекты»**: registry проектов. Каждый проект — карточка/строка с названием, описанием, статусом (active/archived/completed), числом активных задач, прогресс-баром (completed/total), дедлайном если есть. Клик в проект → drill переходит в Tab «Мои» с pre-selected проектом. Можно создать новый проект, архивировать.

**Авто-трекер.** Простой таймер на активной задаче. Старт — фиксирует начало, стоп — записывает elapsed время в задачу, накапливается в total_spent. Опционально на отдельных задачах — «pinned» флаг (если задача pinned и активна, трекер автоматически тикает; снято с pin — стоп).

**Расположение трекера:**
- Desktop: persistent компактный таймер в header (название текущей задачи + elapsed time + stop button).
- Mobile: persistent footer (тот же контент, full-width на bottom).
- На странице задач полная панель: текущая задача, история сегодняшних таймеров, total time today.

**Quick-add из command palette** из любого места, prefilled с контекстом из чата если триггер «поставь задачу...» — modal с распарсенным due_at, выбор pool'а (Для агентов / Мои), если Мои — выбор проекта.

**Recurring задачи:** preset selector (каждый день / каждая неделя / каждый месяц) + custom-cron placeholder с подписью «advanced — будет в v2».

**Dashboard сверху:** сегодня запланировано N, выполнено M, in-progress K, overdue X, total time today H часов. Один statbar, минималистичный.

**Key components mock'а:** все 4 таба с рабочим переключением, по 5-10 задач в каждом, 3 проекта в Tab 4 с drill-in flow, auto-tracker в header (running на одной задаче) и full-panel в Актуальные, quick-add modal.

### D. Контроль и доверие (`D-control-and-trust.html`)

Approval-flow для опасных действий, audit, rollback memory.

**Approval inbox** — mirror Telegram operator-channel. Action sync обоюдная: approve в web → подтверждается в TG; approve в TG → исчезает из web inbox. Web inbox нужен для bulk-review и когда TG-mode неудобен. Каждая запись: что система собирается сделать, какой агент инициировал, какие memory-факты использованы, full context, approve/reject с опциональным комментарием.

**Audit timeline:** все approval-решения за период с фильтрами (по агенту/типу действия/исходу). Каждая запись timestamped, кликабельна для full context.

**Memory rollback:** restore-flow для archived записей. Browse archive → preview → restore back to original layer.

**Confidence-threshold tuner:** slider 0-1 с превью «при threshold X за последнюю неделю pending-инбокс был бы N записей». Visual histogram распределения confidence существующих записей.

**Key components mock'а:** approval inbox с 4-6 pending, full-context view одной approval, audit timeline за последний день, confidence tuner с histogram, restore flow demo.

### E. Расширение и кастомизация (`E-extend-and-customize.html`)

Plugin admin, MCP tool browser, code-tool editor.

**Plugin admin:** список с описанием/версией/статусом (enabled/disabled/error), enable/disable toggle, reload без рестарта, какие хуки регистрирует (pre/post markers).

**MCP tool browser:** инвентарь всех инструментов с описанием, JSON Schema input'a, interactive tester (форма из schema, кнопка execute, результат).

**Code-tool editor:** список созданных tool'ов, их код в Monaco-style блоке (в моке заглушка с syntax-highlighted текстом — `<pre><code>` с CSS для подсветки, не настоящий редактор), sandbox-runner, история запусков.

**Key components mock'а:** plugin grid с 5 plugins (1 disabled, 1 error), MCP browser с 12 tools и tester для одного, code-tool editor открытый на одном tool с историей 5 запусков.

### F. Наблюдение и отладка (`F-observe-and-debug.html`)

OTel инструментирован. Что делает система, сколько стоит, где зависает.

**Cost/latency dashboard:** за период (день/неделя/месяц) total cost, total tokens, p50/p95/p99 latency по моделям, RPM-usage по провайдерам, error rate. Графики простые: sparklines, bar charts, не Grafana-replica.

**Run trace viewer:** один agent-run целиком — все step'ы, tool-calls, memory-операции, timing. Desktop: timeline + tree. Mobile: timeline-only, drill в step через push-screen.

**Logs explorer:** search-bar с фильтрами (session, request, role, time range), virtualized list, click → full detail panel с syntax-highlighted JSON. Quick-link «что было до/после в той же сессии».

**Health panel:** текущий RPM по провайдерам, очередь rate-limiter, last-error по каждому, status night-cycle, backup-status.

**Key components mock'а:** dashboard за сегодня с 3-4 sparklines (cost, tokens, latency, errors), run trace viewer с одним run'ом 12-step, logs explorer с фильтрами и одной expanded entry, health snapshot.

### G. Связность и интеграции (`G-connections-and-integrations.html`)

Telegram + future-интеграции.

**TG chats:** история всех чатов, привязка к scope, PII-policy per-chat, список включённых/выключенных для TG-search. Карточки с last-message preview, badge unread count.

**Integration registry:** placeholder'ы для calendar, email, webhooks. Каждый — disabled card с «coming soon» + краткое описание планируемой интеграции.

**Webhook config:** form для setup webhook URL + secret token.

**Key components mock'а:** TG chats list с 8-10 чатов разного типа (личные, группы, бот), one chat in detail view с per-chat settings, integration grid с 4 placeholder'ами, webhook config form.

### H. Операции (`H-operations-and-housekeeping.html`)

Управление самой системой.

**Night cycle:** big-button «Run night cycle now», status (running/idle/last-result), история последних 7 запусков с timing/processed-count.

**Backup:** status (last-time/size/next-scheduled), big-button «Trigger backup», retention policy display.

**Settings (отдельная секция, не modal):** auth-token rotation, providers list (read-only env-derived), feature flags (NIGHT_CYCLE_HOUR_UTC, FREE_AGENT_INTERVAL_MIN, etc.), system version и uptime.

**System status header:** sticky сверху страницы — version, uptime, current memory usage, deployment health.

**Key components mock'а:** operations dashboard с 2 big-buttons и status panels, settings form с 4 группами (auth, providers, schedulers, advanced), system-status sticky header.

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

**Empty states.** Каждый пустой список/панель — продуманное сообщение с CTA, не белая дыра. Шаблон: иконка (Lucide outline 32px, tertiary color) + h3 заголовок («Нет задач» / «Память пуста») + описание 1-2 строки + primary action button (если есть). Стандартизировать в `components.css`.

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
├─ A-talk-and-remember.html            # ≤600 строк HTML (включая inline data references)
├─ B-delegate-and-autonomous.html
├─ C-tasks-and-projects.html
├─ D-control-and-trust.html
├─ E-extend-and-customize.html
├─ F-observe-and-debug.html
├─ G-connections-and-integrations.html
├─ H-operations-and-housekeeping.html
└─ DESIGN-NOTES.md                     # 1000-1500 слов: rationale, alternatives, mapping tokens → Tailwind
```

**Размер:** каждый mock HTML — 400-600 строк, включая mock-data references из shared/mock-data.js. Если разрастается — разносить inline данные на ещё более компактные.

**`index.html` лобби:** карточки 8 функциональных блоков, у каждой — название + 2-line описание + accent-color стрелка. Без скриншотов/iframe — просто навигация. Шапка с системным статусом (uptime, version) для общего ощущения «приложение, не landing».

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
