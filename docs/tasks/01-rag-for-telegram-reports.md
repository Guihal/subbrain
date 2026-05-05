# Задача 01 — RAG-обогащение перед отправкой отчётов в Telegram

Status: DONE

## Цель

Перед каждой отправкой отчёта в Telegram (автономный агент, `/night-cycle`, ручной `tg_send`) автоматически запускать RAG-тулзу, которая обогащает контекст генерации: актуальные факты из `shared_memory`, свежий `raw_log` за период, релевантные записи `context`/`archive`. Модели, на которой собирается текст отчёта, это даёт фактический фундамент и снижает галлюцинации.

## Текущее состояние

- Отчёты формируются моделью напрямую из того, что накопилось в сессии.
- У «дешёвой» модели нет доступа к долгой памяти во время сборки отчёта → получаются общие тексты без привязки к реальным событиям дня/недели.
- Аналог того, что `context7` делает для документации библиотек — но для нашей внутренней памяти.

## Архитектура

### 1. Новый MCP-тул `report_context`

Файл: `packages/agent/packages/agent/packages/agent/src/mcp/registry/report.tools.ts` (новый), регистрация в `packages/agent/packages/agent/packages/agent/src/mcp/registry/index.ts`.

- `scope: "agent-only"` — не отдаём по REST.
- Вход: `{ topic?: string, since_hours?: number }`. `topic` — тема отчёта (если нет — берём последние сообщения сессии как query). `since_hours` default 24.
- Выход: строка markdown с тремя секциями:
  ```
  ## Факты
  - <shared_memory fact 1>
  - <shared_memory fact 2>

  ## Последние события
  - [<ts>] <raw_log entry 1>
  - [<ts>] <raw_log entry 2>

  ## Связанный контекст
  - <context/archive hit 1>
  - <context/archive hit 2>
  ```

### 2. Сборщик `packages/agent/packages/agent/packages/agent/src/rag/report-context.ts` (новый)

- `MemoryDB.searchShared(topic)` через FTS — топ N фактов (N=10 default).
- `rag.hybridSearch(topic)` — гибридный поиск по `context`+`archive` с rerank, топ K (K=5 default).
- `db.getRecentLog(since_hours)` — выборка из `raw_log` за последние `since_hours`, агрегация по стэйджам (отфильтровать технические `stream-chunk` и т.п.).
- Собирает финальный markdown. Порядок секций фиксированный.

### 3. Обёртка отправки

В `packages/agent/src/mcp/tools/telegram-tools.ts` — новая функция `sendReport(ctx, text, opts?)`. Алгоритм:

1. Если `REPORT_RAG=true` (default) — вызвать `report_context` через `ctx.executor` с `topic=opts.topic ?? extractTopic(text)`.
2. Склеить: `context + "\n\n---\n\n" + text`.
3. Truncation: лимит 3500 байт (TG message ≈ 4096 символов с запасом). Если превышен — отрезаем **префикс** (context) в порядке приоритета «События → Связанный контекст → Факты» (факты наиболее ценные, идут последними под нож).
4. Отправляем через уже существующий TG-sender.

Автономный агент, `/night-cycle`, и любой place где сейчас вызывается прямой `telegram_send` отчёта — переводим на `sendReport`.

### 4. Kill-switch

- Env `REPORT_RAG=true|false` (default `true`). Если `false` — `sendReport` эквивалентен сырому send.

### 5. Принудительный RLM-сбор перед дайджестом

(из [05 секция C2/C3](05-post-refactor-feedback.md)) Каждый дайджест (TG-отчёт, freelance-отчёт, ночной цикл) должен перед генерацией текста запустить **общий сбор RLM** — не просто `report_context`, а полноценную многоступенчатую сборку через `/task` или эквивалент.

- Новый helper: `packages/agent/src/pipeline/digest-prepare.ts` — вызывает `/task`-подобный цикл (агент + критик) с задачей «собери факты для дайджеста на тему X за период Y». Возвращает структурированный markdown.
- Интеграция: `sendReport` сначала пробует `digestPrepare()`, если `DIGEST_RLM=true` (default). При ошибке/таймауте — fallback на `report_context`.
- В system prompt моделей-сборщиков дайджестов — жёсткое правило: «**перед текстом дайджеста обязательно вызови `memory_search` + `telegram_search` + `rlm_collect`**». Без подтверждения использования — модель не отдаёт финальный ответ.
- Env `DIGEST_RLM=true|false` (default `true`), `DIGEST_RLM_TIMEOUT_MS=300000`.

## Тесты

`tests/report-context.test.ts`:
- Мок `MemoryDB` → проверить порядок секций.
- Пустые результаты RAG → возвращается валидный markdown (пустые секции опущены, не `## Факты\n\n`).
- Truncation: сгенерировать длинный контекст > 3500 байт, проверить что в итоге именно Факты сохранились.
- `REPORT_RAG=false` → `sendReport` не зовёт `report_context`.

## Файлы

- `packages/agent/packages/agent/packages/agent/src/mcp/registry/report.tools.ts` (новый)
- `packages/agent/packages/agent/packages/agent/src/mcp/registry/index.ts` (регистрация)
- `packages/agent/packages/agent/packages/agent/src/rag/report-context.ts` (новый)
- `packages/agent/src/mcp/tools/telegram-tools.ts` (обёртка `sendReport`)
- вызовы `telegram_send` для отчётов — заменить на `sendReport` (грепнуть по коду, чтобы не пропустить)
- `tests/report-context.test.ts` (новый)

## Порядок исполнения

1. `packages/agent/packages/agent/packages/agent/src/rag/report-context.ts` + unit-test.
2. MCP-тул `report_context` + регистрация.
3. Обёртка `sendReport` + перевод всех call-sites.
4. Env `REPORT_RAG` + kill-switch проверка.
