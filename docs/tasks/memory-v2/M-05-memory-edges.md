# M-05 · Memory edges (A-MEM lite)

**Tier:** P1 · **Effort:** M · **Deps:** — · **Status:** DONE (commit `3a6c168` + critic round-1 fix-up: weight=const 1.0, MEM-11 audit entry, Status sync)
**Migration assignment:** **14** (M-03 takes 13 — do NOT use 13 here).

## Цель

A-MEM (NeurIPS '25) → Zettelkasten для агентов. На каждый insert LLM находит related memos и рисует edges; new memo триггерит evolution соседей. Subbrain сейчас имеет только `derived_from` JSON (one-way, не запрашивается). M-05 — A-MEM lite: typed edges table + simple insert hook.

После M-05:
- Таблица `memory_edges(src_id TEXT, src_layer TEXT, dst_id TEXT, dst_layer TEXT, kind TEXT CHECK(kind IN ('derives','relates','contradicts','supersedes')), weight REAL DEFAULT 1.0, created_at INTEGER)`.
- Индексы: `(src_id, src_layer)`, `(dst_id, dst_layer)`, `(kind)`.
- Hippocampus после `dedupe` → `linkRelated(newId, layer)` top-3 vec-neighbors → `INSERT INTO memory_edges (kind='relates', weight=cosine_sim)`.
- Backfill: existing `layer2_context.derived_from` (JSON массив id'ов из source memos) → `INSERT … kind='derives'`. One-shot в migration или follow-up script (выбирает subagent).
- `MemoryRepository.getRelated(id, layer, depth=1, kinds?)` — query helper. Depth=1 = direct edges. Depth=2 = 1-hop neighbors of neighbors (опционально, может быть follow-up).

NOT в scope этого тикета:
- `evolution` (A-MEM обновляет атрибуты соседей при новом memo) — отдельный тикет M-05.1.
- `kind='contradicts'` auto-detect (LLM-based contradiction check) — M-05.2.
- `kind='supersedes'` авто-link (это сейчас делается через `superseded_by` колонку в M-07-era schema; не дублировать).

Foundation для **M-06** (reflect step CoALA — promote'ит context patterns в shared, кладёт `derives` edges) и **M-09** (cross-layer dedup использует edges для merge tracking).

## Файлы (scope-lock)

- `packages/core/src/db/schema.ts` — Migration **14** (assigned). `CREATE TABLE memory_edges` + 3 индекса + backfill из `derived_from` JSON. Idempotent под `IF NOT EXISTS` + `user_version < 14` guard. `db.transaction()` + per-statement `.run()`.
- `packages/core/src/db/tables/edges.ts` — **NEW** файл (≤150 LOC). `EdgesTable` класс с методами:
  - `addEdge(srcId, srcLayer, dstId, dstLayer, kind, weight): void`
  - `getEdgesFromSrc(srcId, srcLayer, kinds?): EdgeRow[]`
  - `getEdgesToDst(dstId, dstLayer, kinds?): EdgeRow[]`
  - `getRelated(id, layer, depth?: 1, kinds?): { id, layer }[]` (returns deduped neighbours, layer-pair preserved)
- `packages/core/src/repositories/edges.repo.ts` — **NEW** файл (≤80 LOC). Wraps `EdgesTable`. Methods: `link / getRelated / getEdgesFromSrc / getEdgesToDst`.
- `packages/core/src/db/types.ts` — `EdgeRow` interface (src_id, src_layer, dst_id, dst_layer, kind, weight, created_at) + `EdgeKind` type union.
- `packages/core/src/db/index.ts` — экспорт `EdgesTable`, `EdgeRepository` если нужно для facade.
- `packages/agent/src/pipeline/agent-pipeline/post/extractors.ts` — после `dedupe` в `writeContext` / `writeShared` (если успешный insert и есть rag) → `linkRelated(insertedId, layer)`:
  ```ts
  // M-05: top-3 vec neighbors → kind='relates' edges
  const neighbours = await rag.search({ query: content, layers: [layer], rerankTopN: 3, skipRerank: true });
  for (const n of neighbours) {
    if (n.id === insertedId) continue; // skip self
    edges.link(insertedId, layer, n.id, n.layer, 'relates', n.score ?? 1.0);
  }
  ```
  Должен быть ≤3 edges per insert (cap), non-blocking (errors → log.warn, не throw).
- `tests/memory-edges.test.ts` — **NEW** файл. ≤250 LOC. ≥8 кейсов.
- `docs/02-audit.md` — `### MEM-11 ✅ memory edges (A-MEM lite, закрыто M-05)`.
- `docs/tasks/memory-v2/M-05-memory-edges.md` — Status DONE.

**НЕ трогать:**
- Миграции 1-12 (и 13 — M-03 territory).
- `derived_from` колонка остаётся (back-compat); edges layer additive.
- `superseded_by` колонка (M-06-era через M-07 mig 9). Не дублировать в edges.
- M-07 `kind` (на shared_memory) — это column type, не путать с edge `kind`. Subagent: используй разные имена в TS (`MemoryKind` для shared.kind vs `EdgeKind` для edges).

## Изменение

### Migration 14

```sql
CREATE TABLE IF NOT EXISTS memory_edges (
  src_id TEXT NOT NULL,
  src_layer TEXT NOT NULL CHECK(src_layer IN ('context','archive','shared')),
  dst_id TEXT NOT NULL,
  dst_layer TEXT NOT NULL CHECK(dst_layer IN ('context','archive','shared')),
  kind TEXT NOT NULL CHECK(kind IN ('derives','relates','contradicts','supersedes')),
  weight REAL NOT NULL DEFAULT 1.0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (src_id, src_layer, dst_id, dst_layer, kind)
);

CREATE INDEX IF NOT EXISTS idx_edges_src ON memory_edges(src_id, src_layer);
CREATE INDEX IF NOT EXISTS idx_edges_dst ON memory_edges(dst_id, dst_layer);
CREATE INDEX IF NOT EXISTS idx_edges_kind ON memory_edges(kind);

-- Backfill from layer2_context.derived_from (JSON array of source ids).
-- Skip if memory_edges already populated (count > 0).
-- derived_from format example: '["src1","src2"]' (JSON-stringified array).
INSERT INTO memory_edges(src_id, src_layer, dst_id, dst_layer, kind, weight, created_at)
  SELECT
    je.value AS src_id,
    'context' AS src_layer,  -- assume sources are context-layer for back-compat
    c.id AS dst_id,
    'context' AS dst_layer,
    'derives' AS kind,
    1.0 AS weight,
    c.created_at AS created_at
  FROM layer2_context c, json_each(COALESCE(c.derived_from, '[]')) je
 WHERE c.derived_from IS NOT NULL
   AND c.derived_from <> ''
   AND c.derived_from <> '[]';
```

Backfill notes:
- `derived_from` JSON в context layer хранит ids (без указания layer). Bachfill assumes source = context (heuristic). Если позже окажется что часть source_ids — shared/archive, это можно скорректировать manual SQL миграцией. Out of scope для M-05.
- Idempotency guard: проверить `count(memory_edges) > 0` перед backfill — если уже выполнена (partial run / повторный migrate), skip.

### `linkRelated` hook в extractors

После успешного `dedupe` + insert (в существующем flow `writeContext` и `writeShared`), вызвать `linkRelated`:

```ts
// pseudo-code in extractors.ts:
async function linkRelated(
  insertedId: string,
  layer: 'context' | 'shared',
  content: string,
  rag: RAGPipeline,
  edges: EdgeRepository,
  log: Logger,
): Promise<void> {
  try {
    const neighbours = await rag.search({
      query: content,
      layers: [layer],
      rerankTopN: 3,
      skipRerank: true,
    });
    for (const n of neighbours) {
      if (n.id === insertedId) continue;
      edges.link(insertedId, layer, n.id, n.layer, 'relates', n.score ?? 1.0);
    }
  } catch (err) {
    log.warn(`linkRelated failed for ${insertedId}: ${(err as Error).message}`);
  }
}
```

Wraps в try/catch — RAG failure не должен ломать insert. Logger 2-arg через `child("post.extractors")`.

Cap top-3 (от plan'а, не более) — избегаем O(N²) edge explosion.

### `getRelated` API

```ts
getRelated(id: string, layer: string, depth: number = 1, kinds?: EdgeKind[]): { id: string; layer: string; kind: EdgeKind; weight: number }[]
```

Depth=1 = direct edges (out + in). Depth=2 = 1-hop further (set difference из depth=1 results to avoid loop). Depth>2 — out of scope (graph traversal cost).

## Тесты

`tests/memory-edges.test.ts` (`bun:test`, `data/test-mem5-edges.db`):

1. **Migration 14:** memory_edges table + 3 indexes + PK constraint exist. Idempotent.
2. **`addEdge` inserts row:** sanity. PK uniqueness — повторный `addEdge` с теми же (src/dst/kind) → INSERT OR IGNORE behavior (или throw-and-catch — subagent волен выбрать).
3. **`getEdgesFromSrc` filters by kinds:** insert 3 edges разных kinds; query с `kinds=['relates']` → только relates.
4. **`getRelated(depth=1)` returns direct neighbors:** A->B, A->C → getRelated(A) = [B, C].
5. **`getRelated(depth=2)` returns 1-hop:** A->B->D → depth=2 from A includes D, no loop on A.
6. **Backfill from `derived_from`:** seed context row с `derived_from='["src1","src2"]'`; миграция → 2 edges kind='derives'.
7. **Backfill skips if edges already present:** запуск миграции дважды → edges count тот же.
8. **`linkRelated` integration:** mocked RAG возвращает 3 neighbours; insert через extractors.writeContext → 3 edges kind='relates' созданы.
9. **`linkRelated` skips self:** RAG возвращает inserted id среди neighbours → не creates self-edge.
10. **CHECK constraint blocks invalid kind:** `INSERT … kind='invalid'` → throws.

## Приёмка (machine-checkable)

1. `bunx tsc --noEmit` → exit 0.
2. `bun test tests/memory-edges.test.ts` → all green.
3. `bun test` → ≥678 pass, 0 fail.
4. `sqlite3 <db> "SELECT name FROM sqlite_master WHERE name='memory_edges'"` → 1 row.
5. `sqlite3 <db> "SELECT count(*) FROM sqlite_master WHERE type='index' AND name LIKE 'idx_edges%'"` → 3.
6. `grep -n "linkRelated\|EdgeRepository\|memory_edges" packages/agent/src/pipeline/agent-pipeline/post/extractors.ts packages/core/src/repositories/edges.repo.ts packages/core/src/db/tables/edges.ts` — ≥4 hits.
7. `docs/tasks/memory-v2/M-05-memory-edges.md` Status: DONE.

## Out of scope

- Evolution (A-MEM update of neighbour attributes) — M-05.1.
- LLM-based contradiction detection — M-05.2.
- Auto-supersede via edges (already covered by `superseded_by` column).
- Public MCP curation tools (`memory_link` etc) — M-10.
- Cross-layer dedup using edges — M-09.
- Web UI for edges visualisation.

---

**Status:** DONE (commit `3a6c168` + fix-up — see header)
