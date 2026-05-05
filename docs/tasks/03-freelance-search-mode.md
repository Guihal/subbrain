# Задача 03 — Параллельный поисковый режим по фриланс-биржам

**Status:** DONE (first pass — scaffolding + tests)

## Цель

Отдельный фоновый «поисковый чат» — агент мониторит fl.ru, kwork.ru, freelance.ru на мелкие/средние платные задачи, которые юзер может быстро закрыть (с помощью Claude). Работает параллельно с основным чатом, не мешая ему: основной чат можно не останавливать, основные сессии браузера не ломаются.

Мотив: краткосрочно подзаработать через фриланс, закрывая задачи быстро за счёт инструментов.

## Текущее состояние

- Web-инструменты (`web_navigate`, `browser_snapshot`, ...) работают через `packages/agent/packages/agent/src/mcp/playwright/index.ts` с одним глобальным Playwright-контекстом. Параллельный скраппинг поломает основные сессии.
- Нет отдельного scope для фоновых агентов — автономный агент и основной чат делят один Playwright.

## Архитектура

### 1. Отдельный чат-тег

Миграция: в таблице `chats` добавить колонку `kind TEXT DEFAULT 'main'`. Значения: `main` (сейчас всё такое), `freelance`. Альтернатива без миграции — префикс в `chat_id`: `freelance-<uuid>`, и в коде маршрутизация по префиксу. Предпочитаю колонку — чище.

### 2. HTTP-эндпоинты

Файл: `packages/server/packages/server/packages/server/src/routes/freelance.ts` (новый).

- `POST /v1/search/freelance/start` — запускает scout'а (если не запущен), возвращает `{ chat_id, started_at }`.
- `POST /v1/search/freelance/stop` — останавливает.
- `GET /v1/search/freelance/status` — `{ running, last_run_at, last_lead_at, leads_today }`.
- `GET /v1/search/freelance/leads` — список найденных лидов с пагинацией и фильтром по статусу (`new` / `taken` / `rejected`).
- `PATCH /v1/search/freelance/leads/:id` — `{ status: "taken" | "rejected" }`.

Все под `authMiddleware`, envelope `{ items, total }` — как `routes/memory.ts`.

### 3. Scout

Файл: `packages/agent/src/scheduler/freelance-scout.ts` (новый).

Цикл:
1. `setInterval(scoutTick, FREELANCE_POLL_MIN*60_000)` при `FREELANCE_SCOUT=true`.
2. `scoutTick()` для каждой биржи в списке (`fl.ru`, `kwork.ru`, `freelance.ru`):
   - `browser_navigate` на feed по категории из `FREELANCE_CATEGORIES` (default `web,backend,bots,scripts`).
   - `browser_snapshot` → парсинг списка заказов из a11y-tree (не DOM — стабильнее).
   - Новые (не встречавшиеся, дедуп по url в `memory` теге `freelance-seen`) → в следующий шаг.
3. Фильтр первого уровня (без LLM):
   - Бюджет в диапазоне `[FREELANCE_MIN_BUDGET, FREELANCE_MAX_BUDGET]` (default 2000..30000 RUB).
   - Дедлайн ≥ 1 день.
   - Категория в whitelist.
4. Оценка через `flash`:
   ```
   Вход: заголовок + описание + бюджет + дедлайн + категория.
   Промпт: «Оцени 1–10, насколько быстро пара "разработчик + Claude Code" закроет эту задачу. 10 = час работы. 1 = невозможно.»
   Вывод: число + одна строка обоснования.
   ```
5. `score >= FREELANCE_THRESHOLD` (default 7) → лид:
   - Запись в `memory` shared с тегом `freelance-lead`, поля `{ url, title, budget, score, reason, source }`.
   - Пост в `FREELANCE_TG_CHAT_ID`: `💼 <source> <budget> RUB | <score>/10\n<title>\n<url>\n<reason>`.

### 4. Параллельность с основным чатом

**Ключевое:** у scout'а **свой Playwright context**, изолированный от основного.

- В `packages/agent/packages/agent/src/mcp/playwright/index.ts` — добавить поддержку именованных контекстов: `getContext(name)` возвращает существующий или создаёт новый `browser.newContext({ ... })`.
- Scout работает в контексте `freelance` (`incognito: true` — чистый storage без логинов юзера).
- Основной чат и автономный агент — в контексте `main`.
- Таким образом сессии, куки, авторизации на fl.ru (если появятся) — в `freelance`, не мешают юзеру ничем.

### 5. Rate-limit и защита от банов

- Отдельный bucket rate-limiter'а: `freelance-scout`, лимит **30 req/hour на домен** (биржи могут банить).
- User-Agent — real-browser header. Между переходами — рандомная задержка 5–15 секунд.
- При HTTP 429 или детект «Проверьте, что вы не робот» (маркеры в snapshot) — пауза 6 часов по этому домену + warn в TG: `⚠️ fl.ru rate-limited, пауза до HH:MM`.

### 6. UI

Файлы:
- `web/app/pages/freelance.vue` — страница лидов: таблица (time, source, budget, score, title, buttons [взял] / [не беру] / [открыть]).
- `web/app/composables/useFreelance.ts` — `useFreelance()` с `items`, `total`, `page`, `refresh()`, `mark(id, status)`.
- Ссылку в `ChatSidebar.vue` добавить пунктом `💼 Фриланс` — **в рамках задачи 04 (web-ui-fixes)**, где сайдбар выносится в layout.

### 7. Env

```
FREELANCE_SCOUT=false                  # default — включать осознанно
FREELANCE_POLL_MIN=30
FREELANCE_CATEGORIES=web,backend,bots,scripts
FREELANCE_MIN_BUDGET=2000
FREELANCE_MAX_BUDGET=30000
FREELANCE_THRESHOLD=7
FREELANCE_TG_CHAT_ID=<numeric>
```

## Риски

- **Бан биржи.** fl.ru/kwork могут детектить скрейп. Мы не агрессивны (30 req/hour, рандомные задержки), но вероятность не нулевая. При бане — scout выключается этим доменом, юзер уведомлён.
- **Legal.** ToS бирж обычно запрещают автоматический скрейп. Риск — блокировка аккаунта юзера (если логин), но мы ходим анонимно (incognito-context). Важно: не авторизовываться от имени юзера на бирже.
- **Шум.** Порог 7/10 может быть слишком высокий или низкий, подкрутить эмпирически после первой недели работы.

## Тесты

`tests/freelance-scout.test.ts`:
- Моковый `browser_snapshot` с фейковым feed → парсинг → фильтр → оценка → мок-лиды.
- Дубликаты по url не создают повторные лиды.
- HTTP 429 → пауза, state `paused_until` установлен.
- `/leads` возвращает пагинированный список с правильным фильтром.
- Обновление `status` через PATCH.

## Файлы

- `packages/server/packages/server/packages/server/src/routes/freelance.ts` (новый)
- `packages/agent/src/scheduler/freelance-scout.ts` (новый)
- `packages/core/packages/core/packages/core/src/db/schema.ts` (миграция: `chats.kind`)
- `packages/agent/packages/agent/src/mcp/playwright/index.ts` (поддержка именованных контекстов)
- `web/app/pages/freelance.vue` (новый)
- `web/app/composables/useFreelance.ts` (новый)
- `tests/freelance-scout.test.ts` (новый)

## Порядок исполнения

1. Миграция БД + именованные Playwright-контексты (без этого остальное параллелить опасно).
2. Scout tick + парсер + оценка + TG-alert. Env `FREELANCE_SCOUT=false` дефолтом.
3. HTTP-эндпоинты + UI.
4. Включение на prod, неделя наблюдения, подкрутка порогов.
