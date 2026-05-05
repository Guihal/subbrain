# 05. RAG Pipeline

> Статус: ✅ Реализовано

## Цель

Гибридный поиск по памяти: FTS5 (ключевые слова) + sqlite-vec (семантика) + rerank. Используется Flash-агентом при pre-processing для сборки контекста.

## Архитектура

```
Запрос пользователя
        │
        ▼
┌─────────────────┐
│  Query Analyzer  │  ← nemotron-mini-4b: извлечь ключевые слова + intent
│  (опционально)   │
└────────┬────────┘
         │
    ┌────┴────┐
    ▼         ▼
┌────────┐ ┌──────────┐
│  FTS5  │ │  Vector  │
│ Search │ │  Search  │
│(SQLite)│ │(sqlite-  │
│        │ │  vec)    │
└───┬────┘ └────┬─────┘
    │           │
    └─────┬─────┘
          ▼
┌─────────────────┐
│   Merge + Dedup  │  ← RRF (Reciprocal Rank Fusion) или простое объединение
└────────┬────────┘
         ▼
┌─────────────────┐
│     Rerank      │  ← nvidia/rerank-qa-mistral-4b
│  (top_n=10→5)   │
└────────┬────────┘
         ▼
    Executive Summary
    (контекст для основной модели)
```

## Модели в pipeline

| Этап               | Модель                                         | Расход RPM |
| :----------------- | :--------------------------------------------- | :--------- |
| Embedding запроса  | `nvidia/llama-3.2-nemoretriever-300m-embed-v1` | 1          |
| Rerank             | `nvidia/rerank-qa-mistral-4b`                  | 1          |
| **Итого на поиск** |                                                | **2 RPM**  |

## Параметры

- **FTS5:** `MATCH` по content + tags, `rank` для сортировки
- **Vector:** cosine similarity, top_k=20
- **Rerank:** из 20 кандидатов → top 5
- **Merge:** RRF (k=60) для объединения FTS5 и vector результатов

## Открытые вопросы (решено)

- [x] Размерность вектора `nemoretriever-300m` → **2048** (подтверждено через API)
- [ ] Нужен ли отдельный vector search для кода (`nv-embedcode-7b`)?
- [ ] Порог similarity для отсечения нерелевантного?
- [ ] Кэшировать ли embeddings запросов?

## Реализация

### Файлы

| Файл                   | Описание                                                   |
| :--------------------- | :--------------------------------------------------------- |
| `src/rag/pipeline.ts`  | `RAGPipeline` — гибридный поиск FTS5+vector → RRF → rerank |
| `src/rag/index.ts`     | Barrel export                                              |
| `src/mcp/executor.ts`  | `ragSearch()` + auto-embed on `memoryWrite()`              |
| `src/mcp/tools.ts`     | MCP tool `rag_search`                                      |
| `src/mcp/transport.ts` | REST endpoint `rag_search`                                 |
| `tests/rag.test.ts`    | Интеграционные тесты                                       |

### Ключевые решения

- **Graceful degradation**: если vector search или rerank недоступен (нет провайдера, сеть) — pipeline работает на FTS5 alone
- **Auto-embed**: `memoryWrite()` автоматически вызывает `rag.indexEntry()` (fire-and-forget, приоритет `low`)
- **12 MCP tools**: добавлен `rag_search` к существующим 11
- **RPM-экономия**: FTS5 бесплатен (локально), vector стоит 1 RPM, rerank ещё 1 RPM. Итого 0-2 RPM на запрос
