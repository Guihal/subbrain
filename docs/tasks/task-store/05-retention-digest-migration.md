# Phase 5 — Retention + weekly digest + migration

**Complexity:** complex. **Estimate:** 0.75 day.
**Depends on:** Phase 1 (listCompletedTasksSince, insertArchive, upsertEmbedding ready), Phase 4 (tg-tasks существуют; можно без — retention общий).
**Trigger:** `/task --depth=complex <весь этот файл как prompt>`.

## Цель

Закрытые задачи (`done`/`cancelled`) не должны накапливаться в `tasks` таблице годами, но и потеряться не должны. Решение: ночная очистка (night-cycle Step 11) — для каждой ISO-недели по `completed_at` собираем `done`-задачи в один `layer3_archive` entry как weekly digest, делаем embed+upsert, удаляем оригиналы в той же transaction. Cancelled >1d — просто DELETE без digest. + one-shot migration script `migrate-tasks-from-memory.ts` для initial cleanup shared_memory от старых TODO-подобных записей.

## Проблема которую решаем

1. `tasks` таблица растёт → prompt injection видит больше истории, но `listTasksActive` фильтрует `status IN ('open','in_progress')` — active cap всё равно работает. Вопрос косметический + дисковое место + slow /history.
2. Старые `shared_memory` записи с тегами `task|todo|reminder|deadline` были созданы до Phase 1 — их нужно мигрировать в `tasks` (scope="global"), чтобы hippocampus больше не "помнил" их из shared.
3. Без digest — теряется исторический след "что агент делал за неделю".

## Scope

### 1. Night-cycle Step 11 — pruneCompletedTasks

**File:** `packages/agent/packages/agent/packages/agent/packages/agent/src/pipeline/night-cycle/prune/tasks.ts` (new, ≤200 lines). По аналогии с `prune/shared.ts` и `prune/context.ts` (уже существуют, см. ревизию 01:29 в `~/vault/RLM/Daily/2026-04-22.md`).

```ts
export async function pruneCompletedTasks(
  memory: MemoryDB,
  rag: RAGPipeline,
): Promise<number> {
  const log = logger.child("night").info;
  // Group done>7d by SQLite %W (Monday-based ordinal 00..53, NOT ISO-8601).
  const weeks = memory.db.query(`
    SELECT strftime('%Y-W%W', completed_at, 'unixepoch') AS week, COUNT(*) AS n
    FROM tasks
    WHERE status='done' AND completed_at < unixepoch() - 7*86400
    GROUP BY week
  `).all() as { week: string; n: number }[];

  let pruned = 0;
  for (const { week, n } of weeks) {
    const tasks = memory.db.query(`
      SELECT id, scope, title, description FROM tasks
      WHERE status='done' AND completed_at < unixepoch() - 7*86400
        AND strftime('%Y-W%W', completed_at, 'unixepoch') = ?
    `).all(week) as { id: string; scope: string; title: string; description: string }[];

    const content = tasks.map(
      t => `- [${t.scope}] ${t.title}${t.description ? "\n  " + t.description : ""}`
    ).join("\n");

    // Embed OUTSIDE tx: if fails → continue, retry next cycle.
    let vec: Float32Array;
    try {
      vec = await rag.embedContent(content);
    } catch (e) {
      log("night.prune", `embed week=${week} failed, will retry next cycle: ${String(e)}`);
      continue;
    }

    // Lowercase label: YYYY-wNN (visually distinct from ISO-8601 YYYY-Www).
    const label = week.toLowerCase().replace(/-w/, "-w"); // e.g. "2026-W17" → "2026-w17"
    const archiveId = randomUUID();
    try {
      memory.db.transaction(() => {
        memory.insertArchive(
          archiveId,
          `Completed tasks ${label}`,
          content,
          `tasks,digest,${label}`,
          [],
          "HIGH",
          "night-cycle",
        );
        memory.upsertEmbedding(archiveId, "archive", vec);
        memory.db.query(`
          DELETE FROM tasks WHERE status='done'
            AND completed_at < unixepoch() - 7*86400
            AND strftime('%Y-W%W', completed_at, 'unixepoch') = ?
        `).run(week);
      })();
      pruned += n;
    } catch (e) {
      log("night.prune", `tx week=${week} failed: ${String(e)}`);
    }
  }

  // Cancelled >1d — DELETE without digest.
  const cancelled = memory.db.query(`
    DELETE FROM tasks WHERE status='cancelled' AND updated_at < unixepoch() - 86400
  `).run();

  return pruned + cancelled.changes;
}
```

### 2. Call в night-cycle

**File:** `packages/agent/packages/agent/packages/agent/packages/agent/src/pipeline/night-cycle/index.ts`. Добавить Step 11 после `pruneFocus`:

```ts
log.info("Pruning completed tasks…");
try {
  const n = await pruneCompletedTasks(this.memory, this.rag);
  log.info(`tasks pruned=${n}`);
  result.tasksPruned = n;
} catch (err) {
  const msg = (err as Error).message;
  log.error(`Prune tasks failed: ${msg}`);
  result.errors.push(`Prune tasks: ${msg}`);
}
```

**File:** `packages/agent/packages/agent/packages/agent/packages/agent/src/pipeline/night-cycle/types.ts` — добавить `tasksPruned: number` в `NightCycleResult`.

### 3. ISO-week edge case docs

**File:** `docs/night-cycle.md` (new или update). Параграф "Weekly digest week numbering":

> SQLite `%W` = Monday-based week ordinal (00..53), **NOT** ISO-8601. Weeks can span year boundary — e.g. `2025-w52` digest may contain tasks completed from Dec 29 to Jan 4. Digest label is lowercase `YYYY-wNN` to visually distinguish from ISO-8601 `YYYY-Www`. Grouping happens on SQLite side via `strftime('%Y-W%W', completed_at, 'unixepoch')` in UTC. JS `Date` is not involved in bucket decision — tz consistency preserved.

### 4. Migration script

**File:** `scripts/migrate-tasks-from-memory.ts` (new). Standalone bun script, runs once:

```bash
bun run scripts/migrate-tasks-from-memory.ts           # dry-run: list only
bun run scripts/migrate-tasks-from-memory.ts --apply   # actually move
```

Pseudo-pipeline:
1. SELECT shared_memory + layer2_context WHERE `tags LIKE '%task%' OR tags LIKE '%todo%' OR tags LIKE '%reminder%' OR tags LIKE '%deadline%' OR tags LIKE '%дедлайн%' OR tags LIKE '%задача%'`.
2. Blacklist filter: exclude rows where `tags` contains `architecture|design|pattern|how-to`.
3. Per row: send to LLM (`coder` model via router) with structured-output schema:
   ```json
   {"action": "migrate", "scope": "global|autonomous|...", "title": "...", "description": "...", "priority": 0, "due_at": null}
   // or
   {"action": "keep", "reason": "..."}
   ```
4. On `migrate`: in one `db.transaction`:
   - `memory.insertTask(...)` or `upsertTaskBySource` with stable `source="migrated:{orig_table}:{orig_id}"`.
   - `DELETE FROM shared_memory WHERE id=?` (or context).
   - Append JSON line to `scripts/migration-log/tasks-YYYY-MM-DD.jsonl`:
     ```json
     {"source_table":"shared_memory","source_id":"...","original_content":"...","original_tags":"...","new_task_id":"...","ts":1234567890}
     ```
5. On `keep`: log reason, don't touch.

**File:** `scripts/rollback-migration.ts` (new). Восстанавливает source rows из JSONL log:
```bash
bun run scripts/rollback-migration.ts scripts/migration-log/tasks-YYYY-MM-DD.jsonl
```

### 5. Step 12 — collectStrayTasks в night-cycle

Same LLM-классификация, но за **новые** записи в shared/context (не при initial migration). Вызывается раз в ночь после Step 11.

**File:** `packages/agent/packages/agent/src/pipeline/night-cycle/prune/stray-tasks.ts` (new). Logic:
- SELECT shared/context rows созданные с last night-cycle (через `night_cycle_last_processed_id` focus key).
- Apply тот же regex filter + blacklist как migration.
- LLM classify → migrate/keep.
- On migrate: insert task + delete source in tx. **No JSONL log** (это part of normal night-cycle, не one-shot).

### 6. /v1/tasks/history теперь показывает digests

Уже есть REST `GET /v1/tasks/history` в [packages/server/packages/server/src/routes/tasks.ts](../../../packages/server/packages/server/src/routes/tasks.ts) — возвращает live `done|cancelled` за 7d. Phase 5 расширяет: также merge `layer3_archive WHERE tags LIKE '%tasks,digest,%'`. Фильтр по scope — через parsing контента или через metadata row (task digests не привязаны к одному scope). Простое решение: history возвращает union {live, digests}, клиент группирует.

**Patch:**
```ts
.get("/history", async ({ query }) => {
  const since = query.since === undefined
    ? Math.floor(Date.now() / 1000) - 7 * 86400
    : Number(query.since);
  return paginate(
    (limit, offset) => {
      const live = memory.listCompletedTasksSince({ scope: query.scope, sinceUnix: since, limit: Math.ceil(limit/2), offset: 0 });
      const digests = memory.db.query(`
        SELECT id, title, content, tags, created_at FROM layer3_archive
        WHERE tags LIKE '%tasks,digest,%' AND created_at >= ?
        ORDER BY created_at DESC LIMIT ? OFFSET ?
      `).all(since, Math.floor(limit/2), offset);
      return {
        items: [...live.items.map(t => ({kind:"task", ...t})), ...digests.map(d => ({kind:"digest", ...d}))],
        total: live.total + digests.length,
      };
    },
    query,
  );
}, { query: HistoryQuery });
```

### 7. Tests

`tests/tasks-retention.test.ts`:
- `pruneCompletedTasks` c 0 done-задач >7d → 0 pruned.
- 5 done-задач в одной неделе → 1 archive entry с 5 строками content + embed → 5 tasks удалены.
- 5 done в разных неделях → 5 archive entries (по одной на неделю).
- Embed fail → tasks остаются (nothing deleted).
- Cancelled >1d → DELETE без digest.
- ISO-week edge: задача completed 2025-12-31 и 2026-01-01 — проверить что попали в разные или одну неделю (зависит от %W).

`tests/migrate-tasks-from-memory.test.ts`:
- Shared_memory с task-like tags + blacklist tags → только task-like кандидаты.
- Dry-run не мутирует DB.
- --apply: migrate action создаёт task + удаляет source row + пишет в JSONL.
- Rollback из JSONL восстанавливает source row.

## Edge cases

- `strftime` в SQLite возвращает `NULL` если `completed_at IS NULL` → группировка по NULL week. DB CHECK гарантирует NOT NULL для terminal. Но тест: manual corrupt row (если было) → как prune'нит?
- Week rollover: задача `completed_at = 2025-12-31 23:00 UTC` → `%W='2025-W52'`. Task `completed_at = 2026-01-01 00:30 UTC` → `%W='2026-W00'` или `W01`? Проверить SQLite docs — `%W` первая неделя-полная-в-году.
- Очень много задач в одной неделе (>1000) → content blob огромный → embed может throw на max tokens. Надо chunk или truncate. **Рекомендация:** truncate content до 50KB (≈12K tokens) с префиксом "Completed {N} tasks, showing first M:".
- Migration LLM ошибается и предлагает migrate факт как task → reversible log позволяет rollback. Но даже без rollback — юзер в UI может `task_cancel` со всеми мигрированными за раз.

## Verify

```bash
bunx tsc --noEmit
bun test tests/tasks-retention.test.ts
bun test tests/migrate-tasks-from-memory.test.ts
bun test   # full regression

# Manual: dry-run migration
bun run scripts/migrate-tasks-from-memory.ts

# Manual: trigger night-cycle, проверить result.tasksPruned > 0 на тестовой DB с done-задачами 10d old.
curl -X POST http://localhost:4000/night-cycle
curl http://localhost:4000/night-cycle/status
```

## Out of scope

- Phase 6 web UI `/tasks` History tab — отдельная задача.
- Изменение существующих prune-шагов (shared/context/focus) — работают как есть.
- FTS-индексация digest content — `insertArchive` уже делает через FTS5 trigger.

## Guardrails reminder

- `packages/agent/packages/agent/packages/agent/packages/agent/src/pipeline/night-cycle/prune/tasks.ts` ≤ 250.
- `db.transaction()` для digest + delete atomicity. Embed — outside tx (retry-safe).
- `logger.child("night.prune")`.
- Migration script: `Bun.file()` / `Bun.write()` для JSONL (line-append via `.stream()` или `writeFile(..., {append:true})`).
- Tests: `bun:test`, data/test-retention.db isolated cleanup.

## Что изменяется в git

Новые: `packages/agent/packages/agent/packages/agent/packages/agent/src/pipeline/night-cycle/prune/tasks.ts`, `packages/agent/packages/agent/src/pipeline/night-cycle/prune/stray-tasks.ts`, `scripts/migrate-tasks-from-memory.ts`, `scripts/rollback-migration.ts`, `tests/tasks-retention.test.ts`, `tests/migrate-tasks-from-memory.test.ts`, `docs/night-cycle.md` (или update).
Modified: `packages/agent/packages/agent/packages/agent/packages/agent/src/pipeline/night-cycle/index.ts` (Step 11+12), `packages/agent/packages/agent/packages/agent/packages/agent/src/pipeline/night-cycle/types.ts` (tasksPruned field), `packages/server/packages/server/packages/server/src/routes/tasks.ts` (/history включает digests).
