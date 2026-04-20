# 06. Agent Pipeline: Pre → Main → Post

> Статус: ✅ Реализовано

## Цель

Определить полный цикл обработки запроса через 3 этапа. Каждый этап — отдельный вызов к NVIDIA NIM.

## Общая схема

```
Запрос от VS Code
       │
       ▼
┌──────────────────────────────────────┐
│  1. PRE-PROCESSING (step-3.5-flash)   │
│                                       │
│  Вход: последнее сообщение            │
│  Действия:                            │
│    - RAG Pipeline (→ docs/05)         │
│    - Собрать Слой 1 (фокус)          │
│    - Собрать Слой 2 (контекст)       │
│  Выход: Executive Summary + tools    │
│  RPM: ~3 (embed + rerank + flash)    │
└──────────────┬───────────────────────┘
               ▼
┌──────────────────────────────────────┐
│  2. MAIN EXECUTION (по роли)          │
│                                       │
│  Модель: Model Router (→ docs/03)    │
│  System prompt:                       │
│    - Identity (Слой 1)               │
│    - Executive Summary (от pre)      │
│    - MCP Tools (→ docs/04)           │
│  Выход: ответ пользователю (SSE)     │
│  RPM: 1                              │
└──────────────┬───────────────────────┘
               ▼
┌──────────────────────────────────────┐
│  3. POST-PROCESSING (step-3.5-flash)  │
│                                       │
│  Вход: запрос + ответ + request_id   │
│  Действия:                            │
│    - Извлечь «дельту знаний»         │
│    - log_append → Слой 4 (с ref_id)  │
│    - Обновить tags / embeddings      │
│  Выход: (фоновый, не блокирует)      │
│  RPM: ~2 (flash + embed)            │
└──────────────────────────────────────┘

Итого на 1 запрос: ~6 RPM (из 40)
→ ~6 полных запросов в минуту
```

## Когда НЕ запускать полный цикл

- **Продолжение чата (не первое сообщение):** Пропустить pre-processing, использовать уже собранный контекст.
- **Простые вопросы (short query):** Пропустить RAG, сразу main.
- **Post-processing:** Всегда асинхронный, не блокирует ответ.

## Управление контекстом в длинном чате

| Триггер                         | Действие                                   |
| :------------------------------ | :----------------------------------------- |
| Token count > 80% лимита модели | `step-3.5-flash` сжимает историю в саммари |
| Новая сессия                    | Полный pre-processing                      |
| Смена темы (определяется Flash) | Частичный pre-processing (обновить Слой 2) |

## Traceability

Каждый запрос получает `request_id` (UUID) на входе. Он передаётся во все этапы:

- Pre-processing прикрепляет к Executive Summary
- Main execution получает в контексте
- Post-processing записывает в Слой 4 с `request_id`
- Ночной цикл при компрессии Слой 4 → Слой 3 сохраняет `source_request_ids[]`

Это даёт полную цепочку: факт в памяти → сырой лог → оригинальный запрос.

## Открытые вопросы (решено)

- [x] Как определять «первое сообщение vs продолжение»? → По наличию `assistant` сообщений в истории
- [x] Как определять «простой вопрос» для пропуска RAG? → `userMessage.length < 60`
- [ ] Token counting: tiktoken Bun-совместимый или приблизительно символами?
- [ ] Timeout между этапами?

## Реализация

### Файлы

| Файл                             | Описание                                                        |
| :------------------------------- | :-------------------------------------------------------------- |
| `src/pipeline/agent-pipeline.ts` | `AgentPipeline` — полный 3-этапный цикл                         |
| `src/pipeline/index.ts`          | Barrel export                                                   |
| `src/routes/chat.ts`             | Интеграция: virtual model → pipeline, real model → direct proxy |
| `tests/pipeline.test.ts`         | 6 тестов (pre/post/stream/continuation/focus/sessionId)         |

### Ключевые решения

- **FTS5 query sanitization**: Стоп-слова RU+EN удаляются, термины соединяются через OR
- **Graceful degradation**: RAG/flash failure не ломает pipeline — fallback на focus-only
- **Post-processing fire-and-forget**: Не блокирует ответ пользователю
- **Stream tee**: Для стриминга stream.tee() → клиент + post-processor
- **Knowledge extraction**: Flash извлекает факты из ответа → Layer 2 с auto-embed
- **Context injection**: Prepend к существующему system prompt (не перезаписываем)
- **RPM budget**: Pre ~3 RPM (RAG + flash) + Main 1 RPM + Post ~2 RPM = **~6 RPM/запрос**
