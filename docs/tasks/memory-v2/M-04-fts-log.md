# M-04 · Layer4 episodic-queryable (`fts_log` + RAG layer `"log"`)

**Tier:** P0 · **Effort:** M · **Deps:** — · **Status:** OPEN
**Migration assignment:** **11** (M-07 takes 12 — do NOT use 12 here even if file ordering suggests it).

## Цель

Сейчас `layer4_log` (episodic substrate — каждый chat exchange, scheduler-tick, hippocampus-step) — write-only. Нет FTS, нет vec, нет retrieval API. RAG не может цитировать "что было сказано вчера". Это лишает агента episodic-памяти в SOTA-смысле (LongMemEval-2025 multi-session ability).

После M-04: `fts_log` (FTS5 mirror над `layer4_log.content` + `role`) + `LogRepository.searchLog(query, opts)` + RAG-layer `"log"` (FTS-only ветка, без vec — vec на 100k+ rows слишком write-amp + privacy). Public scope `/v1/memory/log` остаётся read-only без `?q` (PII в логах до scrub'а); `searchLog` доступен только через MCP `agent-only` scope. Никакого embed'а layer4 в этом тикете — rolling N=10k embed-пасс — отдельный follow-up M-04.1.

## Файлы (scope-lock — изменять ТОЛЬКО эти)

- `src/db/schema.ts` — Migration **11** (assigned). FTS5 virtual table `fts_log` (content+role, content_rowid=id) + 3 trigger'а AFTER INSERT/DELETE/UPDATE на `layer4_log`. **НЕ** трогать существующие миграции (1-10).
- `src/db/types.ts` — расширить `RAGSearchOptions['layers']` тип чтобы принимать `"log"` (если он сейчас union строк) ИЛИ добавить отдельный enum / const массив.
- `src/db/tables/log.ts` — **NEW** файл. `LogTable` класс с методом `searchLog(query: string, opts?: { limit?: number, agentId?: string, sessionId?: string }): FtsResult[]`. Использовать `sanitizeFtsQuery` (`src/lib/fts-utils.ts`) на вход. JOIN `fts_log` ↔ `layer4_log` по rowid. Default limit=20.
- `src/repositories/log.repo.ts` — добавить `searchLog` метод (public API). Делегирует в `LogTable.searchLog`. Если `LogRepository` нет — создать или extend существующее место.
- `src/db/index.ts` — экспортировать `LogTable` если нужно для facade `MemoryDB`.
- `src/rag/pipeline.ts` — расширить `searchHybrid` чтобы при `layers: ["log"]` дёргал FTS-only ветку через `logRepo.searchLog(query)`. Vec-ветка skip для `log`. RRF merge всё ещё работает (FTS-only score). Bump-access **НЕ** делать на log layer (M-02 `isBumpLayer` уже фильтрует). Recency boost — оставить (актуально для логов).
- `src/mcp/registry/memory.tools.ts` ИЛИ `src/mcp/registry/rag.tools.ts` — добавить `memory_log_search` tool с **scope: "agent-only"**, TypeBox схема `t.Object({ query, limit?, agentId?, sessionId? })`. Handler делегирует в `executor.ragSearch({ layers: ["log"], query, ... })` или прямо в `logRepo.searchLog`.
- `src/routes/memory.ts` — НЕ добавлять `?q=` поддержку для `/v1/memory/log`. Оставить read-only listing. (Защита от PII утечки через public REST.)
- `tests/fts-log.test.ts` — **NEW** файл (4-6 кейсов).
- `docs/02-audit.md` — добавить `### MEM-8 ✅ fts_log + RAG layer "log" (закрыто M-04)` справочную секцию.
- `docs/tasks/memory-v2/M-04-fts-log.md` — Status: DONE.

**НЕ трогать:**
- Любые существующие миграции (1-10).
- Embedding слой (`src/rag/pipeline.ts` vec branch для context/archive/shared — без изменений).
- `src/services/memory.service.ts` — log не пишется через service (он пишется через `logger.ts` напрямую).
- `web/app/pages/memory.vue` — UI `/memory` `Log` tab остаётся read-only без поиска (отдельный follow-up).

## Изменение

### Migration 11 (additive, идемпотентно)

В `migrate()` после Migration 10 block:
```sql
CREATE VIRTUAL TABLE IF NOT EXISTS fts_log USING fts5(
  role, content,
  content='layer4_log', content_rowid='id',
  tokenize='porter unicode61'
);

-- Triggers — keep fts_log in sync. Pattern matches fts_context/fts_archive/fts_shared (see schema.ts:153-200).
CREATE TRIGGER IF NOT EXISTS fts_log_ai AFTER INSERT ON layer4_log BEGIN
  INSERT INTO fts_log(rowid, role, content) VALUES (new.id, new.role, new.content);
END;

CREATE TRIGGER IF NOT EXISTS fts_log_ad AFTER DELETE ON layer4_log BEGIN
  INSERT INTO fts_log(fts_log, rowid, role, content) VALUES('delete', old.id, old.role, old.content);
END;

CREATE TRIGGER IF NOT EXISTS fts_log_au AFTER UPDATE ON layer4_log BEGIN
  INSERT INTO fts_log(fts_log, rowid, role, content) VALUES('delete', old.id, old.role, old.content);
  INSERT INTO fts_log(rowid, role, content) VALUES (new.id, new.role, new.content);
END;

-- Backfill from existing rows.
INSERT INTO fts_log(rowid, role, content)
  SELECT id, role, content FROM layer4_log;

PRAGMA user_version = 11;
```

Wrap в `db.transaction()` с per-statement `.run()`. `IF NOT EXISTS` + `user_version < 11` guard для идемпотентности. Backfill — выполнять только если rowcount fts_log < layer4_log (защита от двойного backfill после ручного reset). Practical guard: `SELECT count(*) FROM fts_log` = 0 → backfill, иначе skip.

### `LogTable.searchLog`

Файл `src/db/tables/log.ts` (новый, ≤150 LOC):

```ts
export class LogTable {
  constructor(private db: Database) {}

  searchLog(query: string, opts: { limit?: number; agentId?: string; sessionId?: string } = {}): FtsResult[] {
    const sanitized = sanitizeFtsQuery(query);
    if (!sanitized) return [];
    const limit = opts.limit ?? 20;
    let sql = `
      SELECT l.id, l.role AS title, '' AS tags,
             snippet(fts_log, 1, '<b>', '</b>', '...', 32) AS snippet,
             rank, l.created_at, l.created_at AS updated_at
        FROM fts_log
        JOIN layer4_log l ON l.id = fts_log.rowid
       WHERE fts_log MATCH ?
    `;
    const params: unknown[] = [sanitized];
    if (opts.agentId) { sql += " AND l.agent_id = ?"; params.push(opts.agentId); }
    if (opts.sessionId) { sql += " AND l.session_id = ?"; params.push(opts.sessionId); }
    sql += " ORDER BY rank LIMIT ?";
    params.push(limit);
    return this.db.query(sql).all(...params) as FtsResult[];
  }
}
```

`FtsResult` (existing type) — переиспользовать; `id` тут `number` (layer4_log primary key), но shape совместим с union для RAG.

### RAG-layer `"log"`

В `searchHybrid` (`src/rag/pipeline.ts`) при `layers.includes("log")`:
- FTS branch: `logRepo.searchLog(query, { agentId, sessionId, limit: ftsLimit })`. Адаптировать `FtsResult.id` (number) → string для общей дедупликации.
- Vec branch: skip для `"log"` (нет embed'ов). Возвращать пустой массив.
- Rerank: участвует в общем RRF merge / recency boost. Если `skipRerank` или нет других слоёв — ftsLimit topN сразу.
- `bumpAccess`: уже фильтруется через `isBumpLayer` (M-02). Не добавлять "log" в `BumpLayer` union.

Default `layers` массив RAG-pipeline'а **не** менять — `["context","archive","shared"]`. `log` инклюзивен только при явном указании (avoid PII auto-leak в обычный chat-pipeline).

### MCP tool `memory_log_search` (agent-only)

В `src/mcp/registry/memory.tools.ts` (или rag.tools.ts) — `registry.register({ name: "memory_log_search", scope: "agent-only", input: t.Object({ query: t.String(), limit: t.Optional(t.Number()), agentId: t.Optional(t.String()), sessionId: t.Optional(t.String()) }), handler: async (ctx, args) => { ... } })`. Handler возвращает `ToolResult{ ok:true, data: hits }`.

## Тесты

`tests/fts-log.test.ts` (`bun:test`, `data/test-mem4-log.db`):

1. **Migration 11 applies idempotently** — `PRAGMA user_version` ≥ 11 после открытия БД дважды; `fts_log` существует.
2. **Backfill from existing layer4_log** — pre-seed 5 строк в `layer4_log` ДО открытия БД с миграцией 11; после миграции `SELECT count(*) FROM fts_log` = 5.
3. **Trigger insert / delete / update sync** — INSERT новый log row → виден в `fts_log MATCH`. DELETE → не виден. UPDATE content → старый текст не находится, новый находится.
4. **`searchLog` finds by content** — insert 3 rows с разным content; `searchLog("specific keyword")` возвращает соответствующий row, snippet содержит `<b>specific</b>` подсветку.
5. **`searchLog` filters by agentId / sessionId** — insert 4 rows (mix of agent ids); фильтр agent='X' возвращает только X'овые.
6. **`sanitizeFtsQuery` applied** — `searchLog('rare:term*"')` не throw'ит (ranged/quoted-чистка); либо возвращает [], либо безопасный hit.
7. **RAG pipeline `layers: ["log"]` returns log hits** — `rag.search({ query, layers: ["log"], rerankTopN: 5 })` → возвращает array RAGResult'ов с `layer === "log"`.
8. **Public `/v1/memory/log?q=…` ignored** — sanity что рута не парсит `?q` (если есть test для memory routes — extend, иначе skip).

## Приёмка (machine-checkable)

1. `bunx tsc --noEmit` → exit 0.
2. `bun test tests/fts-log.test.ts` → all green.
3. `bun test` (полный) → exit 0, ≥650 pass (baseline после M-02), 0 fail.
4. `sqlite3 <test-db> "SELECT name FROM sqlite_master WHERE name='fts_log'"` → 1 row.
5. `sqlite3 <test-db> "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='layer4_log'"` → ≥3 rows (ai/ad/au).
6. `grep -n "fts_log\|searchLog" src/db/tables/log.ts src/repositories/log.repo.ts src/rag/pipeline.ts` — все три файла ссылаются на новые APIs.
7. `grep -n "memory_log_search" src/mcp/registry/` → ≥1 hit, `scope: "agent-only"`.
8. `docs/tasks/memory-v2/M-04-fts-log.md` — `Status: DONE (PR <sha>)`.

## Риск + mitigations

- **PII в логах до scrub'а** — log row содержит сырой user input до night-cycle PII-scrub. Mitigation: `searchLog` exposed только через MCP agent-only; public `/v1/memory/log` не получает `?q` параметр. Если будущий M-04.1 добавит embed — обязательно скрабить first.
- **Backfill на больших БД** — `INSERT INTO fts_log SELECT … FROM layer4_log` на 100k rows = несколько секунд. Acceptable одноразово при first migrate. Index growth ~30% от raw text size.
- **Migration race с M-07** — оба тикета добавляют миграции (M-04=11, M-07=12). Plan-level фиксированы числа. Если оба собираются параллельно: merge в порядке M-04 → M-07 (по docs/tasks/memory-v2/README.md sequencing). Конфликт схемы маловероятен, миграции touch разные таблицы.
- **FTS5 query syntax errors** — `sanitizeFtsQuery` уже в репо; обязательно использовать. Тест 6 это покрывает.

## Out of scope

- Rolling N=10k embed для log (M-04.1 follow-up).
- UI поиск по `/memory` Log tab (M-04.2).
- Auto-PII-scrub перед searchLog (опасно — может удалить релевантные facts).
- vec branch для log layer.
- Cross-layer dedup log↔context (M-09).

---

**Status:** OPEN
