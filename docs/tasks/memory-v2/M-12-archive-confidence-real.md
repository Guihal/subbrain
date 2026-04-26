# M-12 · Archive confidence HIGH/LOW → REAL

**Tier:** P2 · **Effort:** XS · **Deps:** — · **Status:** OPEN
**Migration assignment:** **15** (M-10 не нуждается в migration).

## Цель

`layer3_archive.confidence` сейчас `TEXT CHECK('HIGH'|'LOW') DEFAULT 'HIGH'` — наследие до миграции 8 (M-FINAL2 audit context). Все остальные слои (`shared_memory`, `layer2_context`) после mig 8 имеют `confidence REAL` с диапазоном [0, 1] + `MEMORY_AUTOACCEPT_CONFIDENCE` (default 0.8) threshold для status='active' vs 'pending'.

Archive имеет binary HIGH/LOW = семантическая разница. M-12 унифицирует:
- Migration 15: `layer3_archive.confidence` `TEXT` → `REAL`. Backfill: `'HIGH' → 0.9`, `'LOW' → 0.4`.
- Drop CHECK constraint (старый `IN ('HIGH','LOW')` уходит).
- TS type `ArchiveRow.confidence`: `'HIGH' | 'LOW'` → `number | null`.
- Все callers / writers — adjust.

После M-12: schema fully consistent across 3 layers.

## Файлы (scope-lock)

- `src/db/schema.ts` — Migration **15** (assigned). SQLite не позволяет ALTER COLUMN type → нужен rebuild через temp table + INSERT SELECT + DROP + RENAME. Pattern matches Migration 3/7 (layer4_log_new). Под `db.transaction()` + per-statement `.run()`. Idempotent guard `if (version < 15)`.
- `src/db/types.ts` — `ArchiveRow.confidence: number | null` (заменить TEXT-union).
- `src/db/tables/memory.ts` — `insertArchive`, `updateArchive`, `getArchive`, `searchArchive`, `getArchiveMany` — adjust типы. SELECT *... возвращает теперь REAL.
- `src/repositories/memory.repo.ts` — отражает изменение типа.
- `src/services/memory.service.ts` — если есть `insertArchive` методы — adjust.
- `src/pipeline/night-cycle/steps/anti-patterns-step.ts` (или эквивалент) — это писатель в archive с HIGH/LOW. Mapping 'HIGH' → 0.9, 'LOW' → 0.4.
- `src/pipeline/night-cycle/process-session.ts` (если пишет в archive) — same.
- `src/routes/memory.ts` — admin endpoint `/v1/memory/archive` PATCH/POST validation: TypeBox `t.Optional(t.Number({minimum:0, maximum:1}))` вместо string-enum.
- `web/app/composables/useMemory.ts`, `web/app/components/MemoryRow.vue`, `web/app/pages/memory.vue` — frontend rendering: было label "HIGH"/"LOW", теперь число (или label по threshold ≥0.7 → "high", иначе "low"). Минимально invasive — один файл UI fix.
- `tests/memory-archive-confidence.test.ts` — **NEW** ≤120 LOC. ≥6 кейсов.
- `docs/02-audit.md` — `### MEM-14 ✅ archive confidence унификация (закрыто M-12)`.
- `docs/tasks/memory-v2/M-12-archive-confidence-real.md` (этот) — Status DONE.

**НЕ трогать:**
- Migrations 1-14.
- shared_memory / layer2_context confidence (уже REAL).
- archive embed / FTS / vec — schema-rebuild сохраняет данные.

## Изменение

### Migration 15 (schema rebuild)

Pattern from migration 3/7:

```sql
CREATE TABLE IF NOT EXISTS layer3_archive_new (
  id                 TEXT PRIMARY KEY,
  title              TEXT NOT NULL,
  content            TEXT NOT NULL,
  tags               TEXT NOT NULL DEFAULT '',
  source_request_ids TEXT NOT NULL DEFAULT '[]',
  confidence         REAL DEFAULT NULL,         -- was TEXT CHECK
  agent_id           TEXT,
  created_at         INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at         INTEGER NOT NULL DEFAULT (unixepoch()),
  -- M-02 columns:
  last_accessed_at   INTEGER DEFAULT NULL,
  access_count       INTEGER NOT NULL DEFAULT 0,
  -- M-03 columns:
  salience           REAL NOT NULL DEFAULT 0.5,
  last_decayed_at    INTEGER DEFAULT NULL
);

INSERT INTO layer3_archive_new
  SELECT id, title, content, tags, source_request_ids,
         CASE confidence WHEN 'HIGH' THEN 0.9 WHEN 'LOW' THEN 0.4 ELSE NULL END,
         agent_id, created_at, updated_at,
         last_accessed_at, access_count, salience, last_decayed_at
    FROM layer3_archive;

DROP TABLE layer3_archive;
ALTER TABLE layer3_archive_new RENAME TO layer3_archive;

-- Indexes из M-02 / M-07 (если archive не получил kind в M-07 — подтверждено) — re-create:
CREATE INDEX IF NOT EXISTS idx_archive_access ON layer3_archive(last_accessed_at DESC);
CREATE INDEX IF NOT EXISTS idx_archive_salience ON layer3_archive(salience DESC);

-- FTS5 mirror — уже есть (`fts_archive`); если она зависит от rowid layer3_archive — после DROP+RENAME триггеры пересоздаются ниже:
CREATE TRIGGER IF NOT EXISTS fts_archive_ai AFTER INSERT ON layer3_archive BEGIN
  INSERT INTO fts_archive(rowid, title, content, tags) VALUES (new.rowid, new.title, new.content, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS fts_archive_ad AFTER DELETE ON layer3_archive BEGIN
  INSERT INTO fts_archive(fts_archive, rowid, title, content, tags) VALUES('delete', old.rowid, old.title, old.content, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS fts_archive_au AFTER UPDATE ON layer3_archive BEGIN
  INSERT INTO fts_archive(fts_archive, rowid, title, content, tags) VALUES('delete', old.rowid, old.title, old.content, old.tags);
  INSERT INTO fts_archive(rowid, title, content, tags) VALUES (new.rowid, new.title, new.content, new.tags);
END;

PRAGMA user_version = 15;
```

**Note:** Archive не получил `kind` колонку в M-07 (kind only on shared per plan-lock M-07). Не добавлять её здесь.

### Backfill mapping

- `'HIGH'` → `0.9` (0.9 ≥ MEMORY_AUTOACCEPT_CONFIDENCE 0.8 → status='active', что эквивалентно прежнему "HIGH").
- `'LOW'` → `0.4` (< 0.8 threshold → не active).
- `NULL` или прочие → `NULL` (back-compat для legacy rows; в practice not happen — column was NOT NULL DEFAULT 'HIGH').

### Caller updates

- Anti-patterns step: было `confidence: 'HIGH' | 'LOW'` → `confidence: number`. Map: high-conf paths → 0.9, low-conf → 0.4. Можно использовать `MEMORY_AUTOACCEPT_CONFIDENCE` из существующих constants для +epsilon (например 0.85).
- Routes/UI: TypeBox `t.Number({minimum:0, maximum:1})`. Frontend: render `confidence.toFixed(2)` либо label-by-threshold.

## Тесты

`tests/memory-archive-confidence.test.ts`:

1. **Migration 15 backfill HIGH** — pre-seed archive с `confidence='HIGH'` → after migrate → `confidence=0.9`.
2. **Migration 15 backfill LOW** — pre-seed `'LOW'` → `0.4`.
3. **Migration 15 idempotent** — re-open DB → user_version stays 15, no schema change.
4. **`insertArchive` accepts REAL** — service-call с `confidence: 0.7` → SELECT shows 0.7.
5. **TypeBox rejects out-of-range** — admin POST `/v1/memory/archive` с `confidence: 1.5` → 422.
6. **TypeBox rejects 'HIGH' string** — same with `confidence: 'HIGH'` → 422 (прежний format отвергается).
7. **FTS5 trigger sync still works** — INSERT new archive row → fts_archive matches it (sanity что rebuild не сломал FTS).
8. **Indexes preserved** — sqlite_master содержит idx_archive_access / idx_archive_salience.

## Приёмка (machine-checkable)

1. `bunx tsc --noEmit` → exit 0.
2. `bun test tests/memory-archive-confidence.test.ts` → all green.
3. `bun test` → ≥725 pass, 0 fail.
4. `sqlite3 <db> "SELECT typeof(confidence) FROM layer3_archive LIMIT 1"` → "real" (или "null" для NULL rows; не "text").
5. `grep -rn "'HIGH'\|'LOW'" src/ | grep archive | grep -v test | grep -v "//"` → 0 hits (только в migration backfill SQL).
6. M-12 plan file Status: DONE.

## Out of scope

- shared_memory / context confidence — уже REAL, не трогать.
- Tuning thresholds (0.9 / 0.4 backfill values) — следующий M-12.1 если нужно A/B.
- archive `kind` column (M-07.x) — out.
- Performance — schema-rebuild на small data быстр; на 100k+ rows — отдельная задача.

---

**Status:** OPEN
