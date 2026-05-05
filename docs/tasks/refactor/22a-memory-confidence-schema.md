# Задача 22a — Memory confidence/status (schema + pipeline) (MEM-5)

**Оценка:** 1 день
**Зависимости:** 19 (migrations baseline)
**Status:** DONE (PR 22a)

## Цель

Post-hippocampus пишет новые факты в `shared_memory` и `memory` (context/archive) **мгновенно, без оценки уверенности**. Результат: модельные догадки попадают в «глобальные факты» и потом цитируются как истина.

Нужно:

1. Вводим `confidence: REAL` и `status: TEXT CHECK('pending'|'active'|'rejected')` в оба слоя.
2. Post-hippocampus обязан эмитить `confidence: 0..1` при `memory_write`.
3. Ниже `MEMORY_AUTOACCEPT_CONFIDENCE` (env, default `0.8`) — row попадает как `pending`.
4. RAG injection (FTS + vec) выдаёт только `status='active'`.

UI approval — отдельный PR 22b.

## Файлы

- [packages/core/packages/core/src/db/schema.ts](../../../packages/core/packages/core/src/db/schema.ts) — migration 8.
- [packages/agent/packages/agent/src/mcp/registry/memory.tools.ts](../../../packages/agent/packages/agent/src/mcp/registry/memory.tools.ts) — `memory_write` args схема.
- [packages/agent/packages/agent/packages/agent/src/pipeline/agent-pipeline/post/hippocampus.ts](../../../packages/agent/packages/agent/packages/agent/src/pipeline/agent-pipeline/post/hippocampus.ts) — system prompt.
- [packages/agent/packages/agent/packages/agent/src/pipeline/agent-pipeline/post/extractors.ts](../../../packages/agent/packages/agent/packages/agent/src/pipeline/agent-pipeline/post/extractors.ts) — writeShared, writeContext.
- [packages/agent/packages/agent/src/rag/pipeline/index.ts](../../../packages/agent/packages/agent/src/rag/pipeline/index.ts) — FTS + vec фильтры.
- [packages/core/src/db/tables/memory.ts](../../../packages/core/src/db/tables/memory.ts), [shared.ts](../../../packages/core/src/db/tables/shared.ts) — insert/get методы принимают confidence + status, и `getSharedMany` добавить если нет.

## Изменение

### 1. Migration 8

```
-- shared_memory
ALTER TABLE shared_memory ADD COLUMN confidence REAL DEFAULT NULL;
ALTER TABLE shared_memory ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
-- CHECK через triggers (SQLite ALTER не умеет ADD CHECK)
CREATE TRIGGER shared_status_check BEFORE INSERT ON shared_memory
  WHEN NEW.status NOT IN ('pending','active','rejected')
  BEGIN SELECT RAISE(ABORT, 'invalid status'); END;
CREATE TRIGGER shared_status_check_upd BEFORE UPDATE OF status ON shared_memory
  WHEN NEW.status NOT IN ('pending','active','rejected')
  BEGIN SELECT RAISE(ABORT, 'invalid status'); END;

-- memory (context/archive layer)
ALTER TABLE memory ADD COLUMN confidence REAL DEFAULT NULL;
ALTER TABLE memory ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
CREATE TRIGGER memory_status_check BEFORE INSERT ON memory
  WHEN NEW.status NOT IN ('pending','active','rejected')
  BEGIN SELECT RAISE(ABORT, 'invalid status'); END;
CREATE TRIGGER memory_status_check_upd BEFORE UPDATE OF status ON memory
  WHEN NEW.status NOT IN ('pending','active','rejected')
  BEGIN SELECT RAISE(ABORT, 'invalid status'); END;

-- FTS mirror needs status rebuild
DROP TABLE shared_fts;
CREATE VIRTUAL TABLE shared_fts USING fts5(id UNINDEXED, status UNINDEXED, title, content, tags, category, tokenize='porter');
INSERT INTO shared_fts SELECT id, status, title, content, tags, category FROM shared_memory;
-- аналогично memory_fts (для context) если схема идентична

-- Index на status (частый фильтр)
CREATE INDEX IF NOT EXISTS idx_shared_status ON shared_memory(status);
CREATE INDEX IF NOT EXISTS idx_memory_status ON memory(status);

PRAGMA user_version = 8;
```

Всё внутри `db.transaction()`, per-statement `.run()`. Existing rows получают `status='active'` через `DEFAULT` — back-compat.

### 2. `memory_write` args

`confidence: t.Number({ minimum: 0, maximum: 1 })` — **required**. Отсутствие в args → TypeBox 422 (pipeline retry или агент модифицирует вызов).

### 3. Hippocampus prompt

В системном промпте `post/hippocampus.ts` добавить:

> При каждом `memory_write` указывай `confidence` от 0 до 1. 0.9+ = подтверждённый пользователем факт. 0.7–0.9 = сильное следствие из контекста. <0.7 = догадка. Факты <0.8 автоматически попадают в pending и требуют approval.

### 4. Writers (`extractors.ts`)

```
const THRESHOLD = Number(process.env.MEMORY_AUTOACCEPT_CONFIDENCE ?? 0.8);
const status = args.confidence >= THRESHOLD ? "active" : "pending";
memory.insertShared(id, category, content, tags, "post-processing", {
  confidence: args.confidence,
  status,
});
```

Сигнатура `insertShared` / `insertContext` расширяется опциональным объектом `{ confidence, status }`. Back-compat: без объекта — `status='active'`, `confidence=NULL`.

### 5. RAG injection filter

- `rag/pipeline.ts` FTS query: `SELECT ... FROM shared_fts WHERE shared_fts MATCH ? AND status = 'active'`.
- Vec-путь: уже делается batch-lookup. Дополнить SQL: `SELECT ... FROM shared_memory WHERE id IN (?,?,...) AND status = 'active'` в `getSharedMany` (новый метод, аналог `getContextMany`). Rows с `status != 'active'` просто не попадают в `byId` map → выпадают из результатов.
- `memory` (context) layer — то же самое.

### 6. `writeShared` embed — синхронизация с PR 24

PR 24 добавляет embed для writeShared. Если PR 22a мержится первым — добавить embed в эту же задачу (чтобы pending rows можно было искать в UI). Если PR 24 первым — просто убедиться что confidence/status прокидываются через embedding insert.

**Решение:** 22a предполагает PR 24 **либо отдельно** уже решил embed, **либо** внутри 22a писать рядом с существующим не-embedding insertShared. Конкретный порядок merge-а согласовать с исполнителем — в dep-графе 22a и 24 не строго связаны.

## Тесты

`tests/memory-confidence-insert.test.ts`:

- `writeShared({content: "X", confidence: 0.9})` → row `status='active'`.
- `writeShared({content: "Y", confidence: 0.5})` → row `status='pending'`.
- Env `MEMORY_AUTOACCEPT_CONFIDENCE=0.6` + `confidence: 0.65` → `active`.
- `memory_write` без confidence → 422 validation error.

`tests/rag-status-filter.test.ts`:

- Insert 2 shared rows (active + pending) с идентичным content.
- `retrieveShared("X")` → 1 result (только active).
- FTS path: insert 1 active + 1 pending matching query → ровно 1 в результате.
- Vec path: то же, с реальным embed если feasible, иначе stub.

`tests/memory-migration-8.test.ts`:

- Apply migrations на свежую test.db → `PRAGMA user_version = 8`.
- Insert row с `status='garbage'` → trigger кидает.
- Apply migrations на сниппет существующей db с данными → existing rows имеют `status='active'`, `confidence=NULL`.

## Приёмка

- [ ] `bunx tsc --noEmit` = 0.
- [ ] Все новые тесты зелёные.
- [ ] Migration 8 применяется на прод-снэпшот без падений.
- [ ] `GET /v1/memory/shared` возвращает rows с полями `status`, `confidence`.
- [ ] MEM-5 вычеркнут в [docs/02-audit.md](../../02-audit.md) после мерджа 22a+22b.

## Deploy note

```bash
ssh root@109.120.187.244
cd /opt/subbrain
docker compose exec subbrain sh -c 'cp /app/data/subbrain.db /app/data/subbrain.db.pre-mig8'
git pull
docker compose build && docker compose up -d
docker compose logs -f | grep -i migration
```

Rollback: восстановить `subbrain.db.pre-mig8`.

## Known limits

- SQLite ALTER не даёт ADD CHECK — используем triggers на INSERT+UPDATE. В случае raw `UPDATE ... SET status=...` через `db.exec` триггер отработает; через prepared statement с bound parameters — тоже.
- `vec_embedding` таблица не имеет `status` — не нужна, фильтр через `getSharedMany` SQL JOIN.
