# 🧠 Subbrain — Цифровая команда

Инфраструктура когнитивного расширения («второй мозг») и автономная ИИ-корпорация.

**Главная директива:** Легально зарабатывать деньги, предлагать идеи, улучшать качество жизни пользователя и его девушки Ники.

**Интерфейс:** Backend-first. OpenAI-совместимый прокси-сервер, интегрируется в VS Code через Continue. Фронтенд (Nuxt 3) — опционален.

---

## 🛠 Технологический стек

| Компонент           | Решение                                   |
| :------------------ | :---------------------------------------- |
| Runtime             | Bun ≥ 1.3                                 |
| HTTP Framework      | Elysia (SSE/WebSocket из коробки)         |
| БД                  | SQLite + FTS5 + sqlite-vec                |
| Инструменты агентов | MCP (Model Context Protocol) + Playwright |
| Мессенджер          | Telegram Bot API + MTProto (Userbot)      |
| Фронтенд            | Nuxt 3 (порт 3000, опционально)           |

---

## 🤖 Провайдеры и модели

Система использует **три провайдера** через единый интерфейс `LLMProvider`:

| Провайдер                     | Base URL                              | Лимит   | Auth                 |
| :---------------------------- | :------------------------------------ | :------ | :------------------- |
| **GitHub Copilot** (`copilot`) | `https://api.githubcopilot.com`       | 10 RPM  | `GITHUB_COPILOT_TOKEN` (ghu_) |
| **NVIDIA NIM** (`nvidia`)      | `https://integrate.api.nvidia.com/v1` | 40 RPM  | `NVIDIA_API_KEY`               |
| **OpenRouter** (`openrouter`)  | `https://openrouter.ai/api/v1`        | 200 RPM | `OPENROUTER_API_KEY`           |

### Карта виртуальных ролей → реальные модели

| Роль                       | Виртуальное имя | Основная модель          | Провайдер | Fallback              |
| :------------------------- | :-------------- | :----------------------- | :-------- | :-------------------- |
| **Тимлид / Оркестратор**   | `teamlead`      | `claude-sonnet-4.6`      | copilot   | `gpt-4o`              |
| **Кодер / Разработчик**    | `coder`         | `claude-sonnet-4.6`      | copilot   | `gpt-4o`              |
| **Критик / Ревьюер**       | `critic`        | `gemini-3.1-pro-preview` | copilot   | `gpt-4o`              |
| **Генералист / Универсал** | `generalist`    | `claude-sonnet-4.6`      | copilot   | `gpt-4o`              |
| **Хаос (эксперимент)**     | `chaos`         | `gpt-5.4-mini`           | copilot   | `gemini-3-flash-preview` |
| **Pre/Post/Memory**        | `flash`         | `gpt-5.4-mini`           | copilot   | `gpt-4o-mini`         |

### Вспомогательные модели (NVIDIA NIM, не в MODEL_MAP)

| Назначение                  | Модель                                         |
| :-------------------------- | :--------------------------------------------- |
| Embeddings (RAG, 26 языков) | `nvidia/llama-3.2-nemoretriever-300m-embed-v1` |
| Rerank (улучшение RAG)      | `nvidia/rerank-qa-mistral-4b`                  |

> Смена модели для роли — только в `src/lib/model-map.ts`. Список виртуальных имён генерируется динамически из `MODEL_MAP` и отдаётся через `GET /v1/models`.

---

## 🗄 Структура памяти (4 слоя)

Система хранит знания в **Markdown**, а не JSON — лучше воспринимается LLM и не ломается при парсинге.

| Слой              | Таблица SQLite     | Формат                      | Когда загружается                            |
| :---------------- | :----------------- | :-------------------------- | :------------------------------------------- |
| **1 — Фокус**     | `layer1_focus`     | Markdown key/value          | Всегда, в каждом system prompt               |
| **2 — Контекст**  | `memory` (layer=2) | Markdown + YAML frontmatter | Лениво, по релевантности через RAG           |
| **3 — Архив**     | `memory` (layer=3) | Markdown EN, сжатый         | Лениво, результат ночного цикла              |
| **4 — Сырой лог** | `raw_log`          | Plain Text RU               | Не загружается в контекст, только для аудита |
| **Общая память**  | `shared_memory`    | Markdown                    | Всегда, факты о пользователе                 |

**Правило доступа:** `shared_memory` и `layer1_focus` загружаются в каждый system prompt напрямую. Слои 2–3 — только через RAG pipeline при старте нового чата.

---

## ⚙️ Пайплайн запроса

→ [`docs/06-agent-pipeline.md`](docs/06-agent-pipeline.md)

Контекст собирается **только при старте нового чата** (ленивая загрузка). Продолжение существующего чата идёт напрямую.

### Новый чат: 3 этапа

```
Запрос пользователя
      │
      ▼
[1] Pre-processing (flash / step-3.5-flash)
    └─ RAG: FTS5 + vector search + rerank
    └─ Загрузка shared_memory + layer1_focus
    └─ Формирует Executive Summary (hippocampus)
      │
      ▼
[2] Main Execution (teamlead / coder / critic / generalist)
    └─ System prompt = persona + focus + shared_memory + exec_summary
    └─ Доступ к MCP tools: memory_read/write, search, log, browser_*
    └─ Стриминг ответа пользователю
      │
      ▼
[3] Post-processing (flash / step-3.5-flash)
    └─ Анализирует «дельту знаний»
    └─ Записывает в raw_log (Layer 4) с request_id
```

**Управление длинным контекстом:** при приближении к лимиту токенов `step-3.5-flash` сжимает историю чата в Markdown-саммари на лету.

---

## 🌙 Ночной цикл (Cron)

→ [`docs/10-night-cycle.md`](docs/10-night-cycle.md)

Запускается по расписанию, защищает от накопления мусора и дублирования знаний.

```
Layer 4 (raw_log, RU Plain Text)
      │
      ├─ [PII-очистка] nvidia/gliner-pii — удаляет персональные данные
      ├─ [Перевод RU→EN] nvidia/riva-translate-4b — повышает token density
      ├─ [Сжатие] step-3.5-flash — дедупликация + структурирование
      └─ [Запись] Layer 3 (archive, EN Markdown)
```

Дополнительно: формирование списка анти-паттернов «На чём застряли сегодня».

---

## 🚀 Режимы работы

| Режим                | Описание                       | Механика                                                                     |
| :------------------- | :----------------------------- | :--------------------------------------------------------------------------- |
| **Кодинг / Рутина**  | Работа через VS Code           | Proxy → Model Router → Специалист → Ответ + фоновая запись в память          |
| **Общая комната**    | Сложные архитектурные таски    | Параллельный вызов 3–4 специалистов (`Promise.all`), Тимлид синтезирует итог |
| **Автономный режим** | Работа в фоне при неактивности | AgentLoop, каждые 15 мин: дайджест ТГ, поиск вакансий/идей, анализ рутины    |

**Автономный агент** (`src/pipeline/agent-loop/`) имеет доступ к:

- `memory_search` / `memory_write` / `memory_read`
- `log_write` / `raw_log_search`
- `web_navigate` / `web_snapshot` (Playwright MCP)
- `tg_send_message` / `tg_list_chats` / `tg_read_chat`

---

## 🗺 Архитектура

```text
┌──────────────────────────────────────────────────────────┐
│              VS Code (Continue) / Web UI / Telegram      │
└────────────────────────────┬─────────────────────────────┘
                             │ POST /v1/chat/completions
                             ▼
┌──────────────────────────────────────────────────────────┐
│                  BUN + ELYSIA (порт 4000)                │
│                                                          │
│  Auth → Model Router → Rate Limiter → Observability      │
│                                                          │
│  Режим чата:      AgentPipeline (pre → main → post)      │
│  Агент-цикл:      AgentLoop (tool-calling, до 8 шагов)   │
│  Общая комната:   ArbitrationRoom (параллельные агенты)  │
│  Автономный:      Scheduler (каждые 15 мин)              │
└────┬───────────────────────┬──────────────────────┬──────┘
     │                       │                      │
     ▼                       ▼                      ▼
┌──────────────┐   ┌─────────────────┐   ┌──────────────────┐
│ GitHub Models│   │   NVIDIA NIM    │   │   OpenRouter     │
│  (copilot)   │   │  flash, chaos,  │   │  (резервный)     │
│ teamlead,    │   │  embed, rerank  │   │                  │
│ coder,       │   │  40 RPM         │   │  200 RPM         │
│ critic,      │   └────────────────-┘   └──────────────────┘
│ generalist   │
│ 10 RPM       │
└──────┬───────┘
       │
       ▼
┌──────────────────────────────────────────────────────────┐
│                       SQLite DB                          │
│  layer1_focus · shared_memory                            │
│  memory (layer 2-3) · raw_log (layer 4)                  │
│  chats · messages                                        │
│  FTS5 индексы · sqlite-vec embeddings                    │
└──────────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────┐
│              MCP Tools / Playwright Browser              │
│  memory_* · log_* · embed · search                       │
│  web_navigate · web_snapshot · web_click · web_type      │
│  tg_send_message · tg_list_chats · tg_read_chat          │
└──────────────────────────────────────────────────────────┘
```

---

## 📋 Дорожная карта

| #   | Файл                                                       | Описание                                          | Статус |
| :-- | :--------------------------------------------------------- | :------------------------------------------------ | :----- |
| 01  | [`docs/01-server-skeleton.md`](docs/01-server-skeleton.md) | Bun + Elysia, прокси `/v1/chat/completions` + SSE | ✅     |
| 02  | [`docs/02-database-schema.md`](docs/02-database-schema.md) | Схема SQLite: 4 слоя, FTS5, sqlite-vec            | ✅     |
| 03  | [`docs/03-model-router.md`](docs/03-model-router.md)       | Model Router: мульти-провайдер + rate limit       | ✅     |
| 04  | [`docs/04-mcp-tools.md`](docs/04-mcp-tools.md)             | MCP Tools: memory, search, log, embed, browser    | ✅     |
| 05  | [`docs/05-rag-pipeline.md`](docs/05-rag-pipeline.md)       | RAG: embed + FTS5 + rerank (гибридный поиск)      | ✅     |
| 06  | [`docs/06-agent-pipeline.md`](docs/06-agent-pipeline.md)   | Agent Pipeline: pre → main → post                 | ✅     |
| 07  | [`docs/07-auth.md`](docs/07-auth.md)                       | Auth middleware: Bearer-токен                     | ✅     |
| 08  | [`docs/08-observability.md`](docs/08-observability.md)     | Observability: RPM, latency, токены               | ✅     |
| 09  | [`docs/09-arbitration.md`](docs/09-arbitration.md)         | Протокол «Общей комнаты» (арбитраж)               | ✅     |
| 10  | [`docs/10-night-cycle.md`](docs/10-night-cycle.md)         | Ночной цикл: PII → translate → compress           | ✅     |
