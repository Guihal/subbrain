# Задача 24 — Shared RAG fix (RAG-1)

**Оценка:** 2 часа
**Зависимости:** —
**Status:** DONE (PR #24)

## Цель

Shared-слой памяти семантически не ищется.

- [packages/agent/packages/agent/packages/agent/src/pipeline/agent-pipeline/post/extractors.ts:29](../../../packages/agent/packages/agent/packages/agent/src/pipeline/agent-pipeline/post/extractors.ts#L29) — `writeShared` не эмбеддит. `vec_embedding` не пополняется → vec-search не найдёт.
- [packages/agent/packages/agent/src/rag/pipeline/index.ts:156](../../../packages/agent/packages/agent/src/rag/pipeline/index.ts#L156) — vec-путь для shared не подтягивает row. Snippet пустой, title = id.

## Реализация

Закрыто коммитом `8b20ebe` (`fix(rag): embed writeShared + hydrate shared rows in vec path`), попал на main через merge `02e0c0b`.

- `writeShared` стал async: embed с 5s `Promise.race` timeout + `db.transaction(() => { insertShared; upsertEmbedding(id, "shared", vec) })()`. Паттерн zeркален `writeContext`.
- `SharedTable.getSharedMany(ids)` добавлен — batch `WHERE id IN (?,?,...)`.
- `rag/pipeline.ts` vec-путь для shared теперь вызывает `memory.getSharedMany(ids)` → `byId` map заполняется → snippet/title корректные.
- `hippocampus.ts` теперь `await writeShared(...)`.
- Комментарий «intentional — no regression» удалён.

Тесты: `tests/shared-embed-write.test.ts` + `tests/rag-shared-vec.test.ts` — 222 строки, все зелёные.

## Приёмка

- [x] `bunx tsc --noEmit` = 0 (проверено на мёрджнутом main).
- [x] `bun test tests/shared-embed-write.test.ts tests/rag-shared-vec.test.ts` — зелёные.
- [x] `grep rag.indexEntry` / `upsertEmbedding.*shared` в `extractors.ts` — присутствует.
- [x] RAG-1 вычеркнут в [docs/02-audit.md](../../02-audit.md).

## Backfill

Shared rows, записанные ДО PR 24, остаются без эмбеддингов. Отдельный скрипт (`scripts/backfill-shared-embeddings.ts`) — follow-up, не в PR 24.

## Deploy note

```bash
ssh root@109.120.187.244
cd /opt/subbrain
git pull
docker compose build && docker compose up -d
```
