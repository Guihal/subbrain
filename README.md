# Subbrain — Цифровая команда

Инфраструктура когнитивного расширения («второй мозг») с автономными ИИ-агентами.  
**Backend-first:** OpenAI-совместимый прокси-сервер, интегрируется в VS Code через Continue/Cursor.

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

| Роль                 | Виртуальное имя | Реальная модель                                |
| -------------------- | --------------- | ---------------------------------------------- |
| Тимлид / Оркестратор | `teamlead`      | `moonshotai/kimi-k2-thinking`                  |
| Кодер                | `coder`         | `qwen/qwen3-coder-480b-a35b-instruct`          |
| Критик / Ревьюер     | `critic`        | `mistralai/devstral-2-123b-instruct-2512`      |
| Генералист           | `generalist`    | `mistralai/mistral-large-3-675b-instruct-2512` |
| Хаос (эксперимент)   | `chaos`         | `mistralai/mistral-nemotron`                   |
| Pre/Post/Memory      | `flash`         | `stepfun-ai/step-3.5-flash`                    |

Все запросы идут через единый NVIDIA NIM API. Router разрешает виртуальное имя в реальную модель и управляет фоллбэками.

---

## Быстрый старт

### Требования

- [Bun](https://bun.sh/) ≥ 1.3
- Docker + Docker Compose (для продакшена)
- API ключ [NVIDIA NIM](https://build.nvidia.com/)

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
| `NVIDIA_API_KEY`              |      ✅      | API ключ NVIDIA NIM                                |
| `DB_PATH`                     |      —       | Путь к SQLite (по умолчанию `data/subbrain.db`)    |
| `LOG_DIR`                     |      —       | Директория логов (по умолчанию `data/logs`)        |
| `PROXY_PORT`                  |      —       | Порт сервера (по умолчанию `4000`)                 |
| `AUTONOMOUS_ENABLED`          |      —       | `true` в проде, `false` для отключения             |
| `AUTONOMOUS_INTERVAL_MINUTES` |      —       | Интервал автономного режима (по умолчанию `15`)    |
| `AUTONOMOUS_STARTUP_DELAY_MS` |      —       | Задержка первого запуска (по умолчанию `30000`)    |
| `AUTONOMOUS_MAX_STEPS`        |      —       | Макс. шагов за цикл (1–20, по умолчанию `8`)       |
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
models:
  - name: "Лид (Kimi K2 Thinking)"
    provider: openai
    model: teamlead
    apiBase: http://localhost:4000/v1
    apiKey: <PROXY_AUTH_TOKEN>

  - name: "Кодер (Qwen3 Coder 480B)"
    provider: openai
    model: coder
    apiBase: http://localhost:4000/v1
    apiKey: <PROXY_AUTH_TOKEN>
```

Полный список ролей: `teamlead`, `coder`, `critic`, `generalist`, `chaos`, `flash`.

---

## API Endpoints

| Метод  | Путь                     | Описание                               |
| ------ | ------------------------ | -------------------------------------- |
| `POST` | `/v1/chat/completions`   | OpenAI-совместимый чат (stream + sync) |
| `GET`  | `/v1/models`             | Список виртуальных моделей             |
| `POST` | `/v1/embeddings`         | Эмбеддинги через NVIDIA NIM            |
| `GET`  | `/v1/chats`              | История чатов                          |
| `GET`  | `/v1/chats/:id/messages` | Сообщения чата                         |
| `GET`  | `/v1/logs`               | Сырые логи (Layer 4)                   |
| `GET`  | `/metrics`               | RPM, latency, токены                   |
| `GET`  | `/health`                | Healthcheck                            |
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
  providers/        # NVIDIA NIM клиент
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
