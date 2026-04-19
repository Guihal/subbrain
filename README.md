# Subbrain — Цифровая команда

«Второй мозг» — OpenAI-совместимый прокси с автономными агентами, долгосрочной памятью и RAG.  
Интегрируется в VS Code через Continue. Фронтенд (Nuxt 3) — опционален.

---

## Архитектура

```
VS Code (Continue) / Telegram / Web
        │ POST /v1/chat/completions
        ▼
  Bun + Elysia (:4000)
    Auth → Model Router → Rate Limiter → Observability
    ├─ AgentPipeline:   pre (Гиппокамп, flash) → main → post (flash)
    ├─ AgentLoop:       автономный режим, tool-calling, до 8 шагов
    ├─ ArbitrationRoom: параллельный вызов специалистов + синтез Тимлидом
    └─ NightCycle:      cron — PII → translate → compress → deduplicate
        │
        ├→ GitHub Models / Copilot API (10 RPM) — все LLM-роли
        ├→ NVIDIA NIM (40 RPM)                  — embed + rerank
        └→ OpenRouter (200 RPM)                 — резервный провайдер
        │
        ▼
  SQLite (4 слоя памяти + FTS5 + sqlite-vec)
```

---

## Модели

> Все LLM-роли используют **GitHub Models (Copilot API)**. NVIDIA NIM — только embed + rerank.

| Роль | Виртуальное имя | Реальная модель | Fallback |
| ---- | --------------- | --------------- | -------- |
| Тимлид / Оркестратор | `teamlead` | `claude-sonnet-4.6` | `gpt-4o` |
| Кодер / Разработчик | `coder` | `claude-sonnet-4.6` | `gpt-4o` |
| Критик / Ревьюер | `critic` | `gemini-3.1-pro-preview` | `gpt-4o` |
| Генералист / Универсал | `generalist` | `claude-sonnet-4.6` | `gpt-4o` |
| Хаос (эксперимент) | `chaos` | `gpt-5.4-mini` | `gemini-3-flash-preview` |
| Pre/Post/Память | `flash` | `gpt-5.4-mini` | `gpt-4o-mini` |

Embeddings: `nvidia/llama-3.2-nemoretriever-300m-embed-v1` · Rerank: `nvidia/rerank-qa-mistral-4b`

Смена модели для роли — только в `src/lib/model-map.ts`. Список ролей отдаётся динамически через `GET /v1/models`.

---

## Быстрый старт

### Требования

- [Bun](https://bun.sh/) ≥ 1.3
- Docker + Docker Compose (для продакшена)
- `GITHUB_COPILOT_TOKEN` (токен `ghu_`) или `GITHUB_TOKEN` (PAT → device flow при первом старте)
- `NVIDIA_API_KEY` — [build.nvidia.com](https://build.nvidia.com/) (бесплатно)

### Локальный запуск

```bash
bun install
cp .env.example .env  # заполнить согласно разделу «Переменные окружения»
bun run scripts/seed.ts
bun run src/index.ts
```

Сервер стартует на `http://localhost:4000`.

### Docker

```bash
# Сборка и запуск (никогда не использовать down -v — удалит данные!)
docker compose build
docker compose up -d

# Логи
docker compose logs -f subbrain
```

---

## Переменные окружения

| Переменная | Обязательная | Описание |
| ---------- | :----------: | -------- |
| `PROXY_AUTH_TOKEN` | ✅ | Bearer-токен для авторизации клиентов |
| `GITHUB_COPILOT_TOKEN` | ✅ | OAuth-токен `ghu_` (Copilot API — все LLM-роли) |
| `GITHUB_TOKEN` | — | GitHub PAT `ghp_` — фоллбэк, если нет `GITHUB_COPILOT_TOKEN` |
| `NVIDIA_API_KEY` | ✅ | NVIDIA NIM (только embed + rerank) |
| `NVIDIA_BASE_URL` | ✅ | `https://integrate.api.nvidia.com/v1` |
| `OPENROUTER_API_KEY` | ✅ | OpenRouter — резервный провайдер |
| `DB_PATH` | — | Путь к SQLite (по умолчанию `data/subbrain.db`) |
| `LOG_DIR` | — | Директория логов (по умолчанию `data/logs`) |
| `PROXY_PORT` | — | Порт сервера (по умолчанию `4000`) |
| `AUTONOMOUS_ENABLED` | — | `true` в проде, `false` для отключения |
| `AUTONOMOUS_INTERVAL_MINUTES` | — | Интервал автономного режима (по умолчанию `15`) |
| `AUTONOMOUS_STARTUP_DELAY_MS` | — | Задержка первого запуска (по умолчанию `30000`) |
| `AUTONOMOUS_MAX_STEPS` | — | Макс. шагов за цикл (1–20, по умолчанию `8`) |
| `AUTONOMOUS_TASK` | — | Задача для автономного агента |
| `TG_BOT_TOKEN` | — | Токен Telegram-бота |
| `TG_OWNER_CHAT_ID` | — | Chat ID владельца для уведомлений |
| `TG_WEBHOOK_SECRET` | — | Секрет вебхука (по умолчанию = `PROXY_AUTH_TOKEN`) |
| `TG_API_ID` | — | MTProto App ID (Userbot, опционально) |
| `TG_API_HASH` | — | MTProto App Hash (Userbot) |
| `TG_SESSION` | — | MTProto сессия (Userbot) |

---

## Интеграция с Continue (VS Code)

Файл `~/.continue/config.yaml`:

```yaml
name: Subbrain
version: 1.0.0
schema: v1
models:
  - name: "Лид (Claude Sonnet 4.6)"
    provider: openai
    model: teamlead
    apiBase: http://localhost:4000/v1
    apiKey: <PROXY_AUTH_TOKEN>

  - name: "Кодер (Claude Sonnet 4.6)"
    provider: openai
    model: coder
    apiBase: http://localhost:4000/v1
    apiKey: <PROXY_AUTH_TOKEN>

  - name: "Критик (Gemini 3.1 Pro)"
    provider: openai
    model: critic
    apiBase: http://localhost:4000/v1
    apiKey: <PROXY_AUTH_TOKEN>

  - name: "Генералист (Claude Sonnet 4.6)"
    provider: openai
    model: generalist
    apiBase: http://localhost:4000/v1
    apiKey: <PROXY_AUTH_TOKEN>

  - name: "Флэш (GPT-5.4 Mini)"
    provider: openai
    model: flash
    apiBase: http://localhost:4000/v1
    apiKey: <PROXY_AUTH_TOKEN>

  - name: "Хаос (GPT-5.4 Mini)"
    provider: openai
    model: chaos
    apiBase: http://localhost:4000/v1
    apiKey: <PROXY_AUTH_TOKEN>
```

---

## API Endpoints

| Метод | Путь | Описание |
| ----- | ---- | -------- |
| `POST` | `/v1/chat/completions` | OpenAI-совместимый чат (stream + sync) |
| `GET` | `/v1/models` | Список виртуальных моделей |
| `POST` | `/v1/embeddings` | Эмбеддинги через NVIDIA NIM |
| `GET` | `/v1/chats` | История чатов |
| `GET` | `/v1/chats/:id/messages` | Сообщения чата |
| `PATCH` | `/v1/chats/:id` | Обновить модель / название чата |
| `GET` | `/v1/logs` | Сырые логи (Layer 4) |
| `GET` | `/metrics` | RPM, latency, токены |
| `GET` | `/health` | Healthcheck (без авторизации) |
| `POST` | `/autonomous/trigger` | Ручной запуск автономного цикла |
| `GET` | `/mcp` | MCP SSE-транспорт |

Все эндпоинты (кроме `/health`) требуют `Authorization: Bearer <token>`.

---

## Память (4 слоя)

| Слой | Таблица | Формат | Загрузка |
| ---- | ------- | ------ | -------- |
| 1 — Фокус | `layer1_focus` | Markdown key/value | Всегда, в каждом system prompt |
| 2 — Контекст | `memory` (layer=2) | Markdown + YAML frontmatter | По релевантности через RAG |
| 3 — Архив | `memory` (layer=3) | Markdown EN, сжатый | По релевантности, результат ночного цикла |
| 4 — Сырой лог | `raw_log` | Plain Text RU | Не загружается, только для аудита |
| Общая память | `shared_memory` | Markdown | Всегда, факты о пользователе |

Ночной цикл: PII-очистка → перевод RU→EN → дедупликация → запись в Layer 3.

---

## Тесты

```bash
# Unit-тесты (собственный runner, результаты в консоль)
bun run tests/db.test.ts
bun run tests/pipeline.test.ts
bun run tests/rag.test.ts
bun run tests/auth.test.ts
bun run tests/metrics.test.ts
bun run tests/rate-limiter.test.ts
bun run tests/arbitration.test.ts
bun run tests/night-cycle.test.ts
bun run tests/hardening.test.ts

# Интеграционные тесты (требуют живой сервер на :4000)
bun run tests/integration.test.ts
```

---

## Deploy

Конфиги для продакшена в `deploy/`:

- `Caddyfile` — reverse proxy с HTTPS
- `setup-server.sh` — первоначальная настройка VPS

```bash
# Обновить сервер
docker compose build && docker compose up -d

# Обновить Caddy-конфиг
sudo tee /etc/caddy/Caddyfile < deploy/Caddyfile
sudo systemctl reload caddy
```

---

## Архитектура

```
VS Code (Continue)
      │ POST /v1/chat/completions
      ▼
Bun + Elysia (Proxy, :4000)
  ├─ Auth: Bearer token
  ├─ Model Router: роль → модель, очередь 40 RPM
  ├─ Agent Pipeline: pre (Flash) → main → post (Flash)
  ├─ RAG: embed + FTS5 + rerank
  └─ MCP Tools: memory, search, log, embed
      │
      ▼
NVIDIA NIM API (https://integrate.api.nvidia.com/v1)
      │
      ▼
SQLite (4 слоя памяти + FTS5 + sqlite-vec)
```

Фронтенд (`web/`) — Nuxt 3, порт `:3000`, опционален.

---

## Модели (виртуальные роли)

> Все LLM-роли используют **GitHub Models (Copilot API)**. NVIDIA NIM — только embed + rerank.

| Роль                 | Виртуальное имя | Реальная модель          |
| -------------------- | --------------- | ------------------------ |
| Тимлид / Оркестратор | `teamlead`      | `claude-sonnet-4.6`      |
| Кодер                | `coder`         | `claude-sonnet-4.6`      |
| Критик / Ревьюер     | `critic`        | `gemini-3.1-pro-preview` |
| Генералист           | `generalist`    | `claude-sonnet-4.6`      |
| Хаос (эксперимент)   | `chaos`         | `gpt-5.4-mini`           |
| Pre/Post/Память      | `flash`         | `gpt-5.4-mini`           |

Все запросы проходят через `CopilotProvider` — GitHub Models API с авто-обновляемым сессионным токеном. Router разрешает виртуальное имя в реальную модель и управляет фоллбэками.

---

## Первый запуск

### Требования

- [Bun](https://bun.sh/) ≥ 1.3
- Docker + Docker Compose (для продакшена)
- API ключ [NVIDIA NIM](https://build.nvidia.com/)
- GitHub Copilot OAuth-токен (`ghu_`)

### Локальный запуск

```bash
# Установить зависимости
bun install

# Создать .env (см. раздел «Переменные окружения»)
cp .env.example .env

# Наполнить БД базовыми данными
bun run scripts/seed.ts

# Запустить сервер
bun run src/index.ts
```

Сервер поднимется на `http://localhost:4000`.

### Docker

```bash
# Сборка и запуск (никогда не использовать down -v — удалит данные!)
docker compose build
docker compose up -d

# Просмотр логов
docker compose logs -f subbrain
```

---

## Переменные окружения

| Переменная                    | Обязательная | Описание                                           |
| ----------------------------- | :----------: | -------------------------------------------------- |
| `PROXY_AUTH_TOKEN`            |      ✅      | Bearer-токен для авторизации клиентов              |
| `GITHUB_COPILOT_TOKEN`        |      ✅      | OAuth-токен `ghu_` (Copilot API — все LLM-роли)    |
| `GITHUB_TOKEN`                |      —       | PAT `ghp_` — фоллбэк, если нет `GITHUB_COPILOT_TOKEN` |
| `NVIDIA_API_KEY`              |      ✅      | NVIDIA NIM (embed + rerank)                        |
| `NVIDIA_BASE_URL`             |      ✅      | `https://integrate.api.nvidia.com/v1`              |
| `OPENROUTER_API_KEY`          |      ✅      | OpenRouter — резервный провайдер                   |
| `DB_PATH`                     |      —       | Путь к SQLite (по умолчанию `data/subbrain.db`)    |
| `LOG_DIR`                     |      —       | Директория логов (по умолчанию `data/logs`)        |
| `PROXY_PORT`                  |      —       | Порт сервера (по умолчанию `4000`)                 |
| `AUTONOMOUS_ENABLED`          |      —       | `true` в проде, `false` для отключения             |
| `AUTONOMOUS_INTERVAL_MINUTES` |      —       | Интервал автономного режима (по умолчанию `15`)    |
| `AUTONOMOUS_STARTUP_DELAY_MS` |      —       | Задержка первого запуска (по умолчанию `30000`)    |
| `AUTONOMOUS_MAX_STEPS`        |      —       | Макс. шагов за цикл (1–20, по умолчанию `8`)       |
| `AUTONOMOUS_TASK`             |      —       | Задача для автономного агента                      |
| `TG_BOT_TOKEN`                |      —       | Токен Telegram-бота (опционально)                  |
| `TG_OWNER_CHAT_ID`            |      —       | Chat ID владельца для Telegram-бота                |
| `TG_WEBHOOK_SECRET`           |      —       | Секрет вебхука (по умолчанию = `PROXY_AUTH_TOKEN`) |
| `TG_API_ID`                   |      —       | MTProto App ID (Userbot, опционально)              |
| `TG_API_HASH`                 |      —       | MTProto App Hash (Userbot)                         |
| `TG_SESSION`                  |      —       | MTProto сессия (Userbot)                           |

---

## Интеграция с Continue (VS Code)

Файл `~/.continue/config.yaml`:

```yaml
name: Subbrain
version: 1.0.0
schema: v1
models:
  - name: "Лид (Claude Sonnet 4.6)"
    provider: openai
    model: teamlead
    apiBase: http://localhost:4000/v1
    apiKey: <PROXY_AUTH_TOKEN>

  - name: "Кодер (Claude Sonnet 4.6)"
    provider: openai
    model: coder
    apiBase: http://localhost:4000/v1
    apiKey: <PROXY_AUTH_TOKEN>

  - name: "Критик (Gemini 3.1 Pro)"
    provider: openai
    model: critic
    apiBase: http://localhost:4000/v1
    apiKey: <PROXY_AUTH_TOKEN>

  - name: "Генералист (Claude Sonnet 4.6)"
    provider: openai
    model: generalist
    apiBase: http://localhost:4000/v1
    apiKey: <PROXY_AUTH_TOKEN>

  - name: "Флэш (GPT-5.4 Mini)"
    provider: openai
    model: flash
    apiBase: http://localhost:4000/v1
    apiKey: <PROXY_AUTH_TOKEN>

  - name: "Хаос (GPT-5.4 Mini)"
    provider: openai
    model: chaos
    apiBase: http://localhost:4000/v1
    apiKey: <PROXY_AUTH_TOKEN>
```

---

## API Endpoints

| Метод  | Путь                     | Описание                               |
| ------ | ------------------------ | -------------------------------------- |
| `POST` | `/v1/chat/completions`   | OpenAI-совместимый чат (stream + sync) |
| `GET`  | `/v1/models`             | Список виртуальных моделей             |
| `POST` | `/v1/embeddings`         | Эмбеддинги через NVIDIA NIM            |
| `GET`  | `/v1/chats`              | История чатов                          |
| `GET`  | `/v1/chats/:id/messages` | Сообщения чата                         |
| `PATCH`| `/v1/chats/:id`          | Обновить модель / название чата        |
| `GET`  | `/v1/logs`               | Сырые логи (Layer 4)                   |
| `GET`  | `/metrics`               | RPM, latency, токены                   |
| `GET`  | `/health`                | Healthcheck (без авторизации)          |
| `POST` | `/autonomous/trigger`    | Ручной запуск автономного цикла        |
| `GET`  | `/mcp`                   | MCP SSE-транспорт                      |

Все эндпоинты (кроме `/health`) требуют заголовок `Authorization: Bearer <token>`.

---

## Память (4 слоя)

| Слой          | Таблица            | Описание                                                |
| ------------- | ------------------ | ------------------------------------------------------- |
| 1 — Фокус     | `layer1_focus`     | Директивы и самоидентификация, всегда в system prompt   |
| 2 — Контекст  | `memory` (layer 2) | Активные задачи, загружаются по релевантности через RAG |
| 3 — Архив     | `memory` (layer 3) | Сжатые знания (EN), результат ночного цикла             |
| 4 — Сырой лог | `raw_log`          | Полная история запросов и действий                      |
| Общая память  | `shared_memory`    | Факты о пользователе, доступны всем агентам             |

Ночной цикл (Cron): PII-очистка → перевод RU→EN → дедупликация → запись в Layer 3.

---

## Тесты

```bash
# Запуск всех тестов
bun run tests/db.test.ts
bun run tests/pipeline.test.ts
bun run tests/rag.test.ts
bun run tests/auth.test.ts
bun run tests/metrics.test.ts
bun run tests/rate-limiter.test.ts
bun run tests/arbitration.test.ts
bun run tests/night-cycle.test.ts
bun run tests/hardening.test.ts

# Интеграционные тесты (требуют живой API)
bun run tests/integration.test.ts
```

> Unit-тесты используют собственный runner (не `bun:test`), результаты выводятся в консоль.

---

## Deploy

Конфиги для продакшена в `deploy/`:

- `Caddyfile` — reverse proxy с HTTPS
- `setup-server.sh` — первоначальная настройка VPS

```bash
# Обновить сервер
docker compose build && docker compose up -d

# Обновить Caddy-конфиг
sudo tee /etc/caddy/Caddyfile < deploy/Caddyfile
sudo systemctl reload caddy
```

---

## Структура проекта

```
src/
  index.ts          # Точка входа, инициализация
  db/               # MemoryDB (SQLite + FTS5 + sqlite-vec)
  lib/              # Auth, logger, metrics, model-map, rate-limiter
  mcp/              # MCP-сервер (tools: memory, search, log, embed)
  pipeline/         # AgentPipeline, ArbitrationRoom, NightCycle, AgentLoop
  providers/        # GitHub Copilot + NVIDIA NIM клиенты
  rag/              # RAG: embed + hybrid search + rerank
  routes/           # HTTP роуты
  telegram/         # Telegram Bot + MTProto Userbot
scripts/
  seed.ts           # Наполнение Layer 1 + Shared Memory
  audit-db.ts       # Аудит состояния БД
  tg-login.ts       # Получение MTProto сессии
web/                # Nuxt 3 фронтенд (опционально)
docs/               # Детальная документация по каждому модулю
```

---

## Документация

Детальные спецификации в `docs/`:

- [01-server-skeleton.md](docs/01-server-skeleton.md) — Bun + Elysia скелет, SSE
- [02-database-schema.md](docs/02-database-schema.md) — Схема SQLite
- [03-model-router.md](docs/03-model-router.md) — Model Router, очередь RPM
- [04-mcp-tools.md](docs/04-mcp-tools.md) — MCP Tools контракт
- [05-rag-pipeline.md](docs/05-rag-pipeline.md) — RAG pipeline
- [06-agent-pipeline.md](docs/06-agent-pipeline.md) — Agent Pipeline (pre→main→post)
- [07-auth.md](docs/07-auth.md) — Auth middleware
- [08-observability.md](docs/08-observability.md) — Метрики и observability
- [09-arbitration.md](docs/09-arbitration.md) — «Общая комната» (арбитраж)
- [10-night-cycle.md](docs/10-night-cycle.md) — Ночной цикл компрессии
