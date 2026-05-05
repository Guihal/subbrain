# Задача 02 — Polling Telegram и напоминания по задачам

Status: DONE

## Цель

Агент каждые 10 минут опрашивает Telegram (user + bot inbox), сверяет списки рабочих и домашних задач, и раз в 30 минут шлёт напоминание по просроченным / застоявшимся.

## Текущее состояние

- `packages/agent/packages/agent/packages/agent/src/mcp/telegram-tools.ts` уже умеет отправлять и (через MTProto userbot) читать сообщения.
- Нет фонового опроса. Агент «просыпается» только когда его дёргают эндпоинтом автономного режима.
- Списки задач нигде не хранятся структурно — только в свободном тексте `raw_log`.

## Архитектура

### 1. Модель хранения задач

В `layer1_focus` (KV, уже инжектится в каждый system-prompt) — два ключа:

```json
{
  "tasks.work": [
    {"id": "w1", "text": "починить billing webhook", "created_at": 1713600000, "due": 1713700000},
    {"id": "w2", "text": "код-ревью PR #142", "created_at": 1713610000}
  ],
  "tasks.home": [
    {"id": "h1", "text": "оплатить интернет", "created_at": 1713580000}
  ]
}
```

- `id` — короткий, `w<seq>` для work, `h<seq>` для home.
- `due` — optional unix timestamp.
- При `done <id>` задача удаляется из массива (история остаётся в `raw_log`).

### 2. Poller

Файл: `packages/agent/packages/agent/packages/agent/src/scheduler/telegram-poller.ts` (новый).

- Экспортирует `startPoller()`, `stopPoller()`, `pollerRunning` guard (аналогично `nightCycleRunning`).
- В `packages/server/packages/server/packages/server/src/index.ts` при старте (рядом с night-cycle-scheduler): если `process.env.TG_POLLER === "true"` → `startPoller()`. В shutdown-блоке → `stopPoller()`.
- `startPoller()` регистрирует два `setInterval`:
  1. `poll()` — каждые `TG_POLL_INTERVAL_MIN=10` минут.
  2. `remind()` — каждые `TG_REMIND_INTERVAL_MIN=30` минут.
- Guard `pollerRunning` — если текущий `poll()` не успел доработать за 10 мин, следующий тик пропускается.

### 3. `poll()` — чтение TG и разбор команд

1. Через userbot читает новые сообщения из личного чата юзера с ботом/аккаунтом (фильтр по `TG_REMIND_CHAT_ID`).
2. Для каждого нового сообщения парсит команду:
   - `+task work <текст>` → push в `tasks.work` с авто-`id`.
   - `+task home <текст>` → push в `tasks.home`.
   - `+task work <текст> !<YYYY-MM-DD HH:MM>` → push с `due`.
   - `done <id>` → удаляет задачу из соответствующего массива.
   - `list work` / `list home` → бот отвечает текущим списком.
   - Неопознанные сообщения — игнорируются (не наша зона).
3. После обработки — пишет квитанцию обратно: `✓ работа: w3 добавлена` / `✓ w1 закрыта` / `? команда не распознана`.

Poller **не вызывает модели** — только чтение TG + обновление `layer1_focus`. Дёшево.

### 4. `remind()` — сводка просроченных

1. Читает `tasks.work` и `tasks.home` из `layer1_focus`.
2. Фильтр «требует напоминания»:
   - `due` задан и `due < now`;
   - `due` не задан и `created_at < now - 6h`.
3. Если кандидатов нет — молчит (никаких «у тебя нет задач» — спам).
4. Если есть — формирует промпт для `flash`-роли через обычный `ModelRouter.chat` (не через pipeline):
   - Вход: число work/home, топ-3 по каждой категории (по убыванию возраста).
   - Выход: 1–2 строки в стиле «🔔 Work: 5 задач (2 просрочены). Срочно: …. Home: 3».
5. Отправляет в `TG_REMIND_CHAT_ID` через обычный `telegram_send`.

**Не через `sendReport` (задача 01):** это напоминание, а не отчёт — RAG-контекст тут лишний.

### 5. Env

```
TG_POLLER=true                  # default false — kill switch
TG_POLL_INTERVAL_MIN=10
TG_REMIND_INTERVAL_MIN=30
TG_REMIND_CHAT_ID=<numeric_id>  # куда писать квитанции и напоминания
TG_REMIND_STALE_HOURS=6         # порог «без due считаем просроченным»
```

## Тесты

`tests/telegram-poller.test.ts`:
- Мок MTProto reader → поток сообщений с разными командами → проверка обновления `layer1_focus`.
- Команда с duplicate `id` от `done` — ничего не падает, задачи нет в списке.
- `remind()` с разным набором задач — корректный промпт и список кандидатов.
- Нет кандидатов → `remind()` не зовёт модель, не шлёт TG.
- Guard `pollerRunning` — параллельный запуск пропускается.

## Доп. скоуп — MCP-тулза `telegram_search`

Отдельный подпункт этой же задачи (вся TG-инфраструктура). Сейчас агент «не ориентируется» в личных TG-сообщениях пользователя: шум выпилен, но поиска по истории нет, и агент пропускает кучу контекста.

### Тулза
- Регистрация: `packages/agent/packages/agent/packages/agent/src/mcp/registry/telegram.tools.ts`, `scope: "agent-only"`.
- Вход: `{ query: string, chat_id?: string, from?: string, to?: string, limit?: number }` (`from`/`to` — ISO даты, `limit` default 20).
- Логика: `packages/agent/packages/agent/packages/agent/src/mcp/telegram-tools.ts` — FTS5 по отдельному индексу TG-сообщений (или переиспользовать `raw_log` FTS если TG туда пишется).
- Выход: `{ items: [{ts, chat, from, text, message_id}], total }`.

### Индекс
- Проверить: пишутся ли входящие TG в `raw_log`/отдельную таблицу. Если нет — завести `tg_messages` (id, chat_id, from, ts, text) + FTS5 виртуальную таблицу.
- Re-индексация истории: одноразовый скрипт `scripts/tg-reindex.ts`, выгружает последние N сообщений через MTProto, нормализует, пишет в FTS.
- Sanitize запросов через `packages/core/src/lib/fts-utils.ts:sanitizeFtsQuery`.

### Интеграция
- Добавить в system prompt явное правило: «для вопросов про TG-переписку → `telegram_search` прежде чем отвечать».
- Перекликается с [05 секция C2](05-post-refactor-feedback.md#c2-принудительное-использование-rag--rlm) — принудительное использование инструментов поиска.

## Файлы

- `packages/agent/packages/agent/packages/agent/src/scheduler/telegram-poller.ts` (новый)
- `packages/server/packages/server/packages/server/src/index.ts` (старт/стоп, cleanup на shutdown)
- `packages/agent/packages/agent/packages/agent/src/mcp/telegram-tools.ts` (helper для чтения inbox + `searchMessages` для FTS)
- `packages/agent/packages/agent/packages/agent/src/mcp/registry/telegram.tools.ts` (регистрация `telegram_search`)
- `packages/core/packages/core/packages/core/src/db/schema.ts` (таблица `tg_messages` + FTS, если ещё нет)
- `scripts/tg-reindex.ts` (новый — одноразовый backfill истории)
- `tests/telegram-poller.test.ts` (новый)
- `tests/telegram-search.test.ts` (новый)

## Порядок исполнения

1. Helper чтения inbox в `telegram-tools.ts` (если нет).
2. `telegram-poller.ts` + unit-test.
3. Интеграция в `packages/server/packages/server/packages/server/src/index.ts` + env.
4. Проверка на live-боте: `TG_POLLER=true` локально + несколько команд в чат.
