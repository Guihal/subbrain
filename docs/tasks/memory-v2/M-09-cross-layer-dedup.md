# M-09 · Cross-layer dedup + archive→shared promote

**Tier:** P2 · **Effort:** M · **Deps:** M-05 (edges) + M-06 (reflect) — landed · **Status:** DONE
**Migration assignment:** **none** (extends existing tables, uses existing memory_edges).

## Цель

После M-05/M-06: edges существуют, reflect генерирует context→shared promotion, intra-layer dedup в night-cycle (M-06-era). Но дубликаты МЕЖДУ слоями не ловятся:
- Тот же fact живёт в `layer3_archive` (compressed длинная история) И в `shared_memory` (свежая глобальная) — RAG получает оба, сжигает context window.
- `layer3_archive` row с `access_count > 5` фактически = глобальный фундаментальный факт, должен быть в `shared_memory` для system-prompt инъекции.

После M-09: night-cycle step `cross-layer-dedup.ts`:
1. **Cross-layer dedup**: для каждой пары layers (context↔archive, archive↔shared, context↔shared) — найти memos с cosine ≥ 0.92 + тот же kind/category. Marker = `supersedes` edge от старшего/менее-доверенного к младшему/более-доверенному.
2. **archive→shared promote**: archive rows с `access_count ≥ 5` + `confidence ≥ 0.7` → insert copy в shared_memory (kind='semantic', confidence сохранён) + `derives` edge от archive к shared.

NO auto-delete старого memo — только supersede flag (rendering фильтрует superseded). UI `/memory` admin может потом ручной cleanup.

Foundation для **M-11** (sleep-time block rewriter использует cross-layer dedup чтобы не дублировать persona-блоки между layer1_focus и shared.persona).

## Файлы (scope-lock)

- `src/pipeline/night-cycle/steps/cross-layer-dedup.ts` — **NEW** ≤200 LOC. Step функция `runCrossLayerDedup(deps): Promise<CrossLayerResult>` где результат `{ pairs_examined, supersedes_added, promoted_to_shared, errors }`.
- `src/pipeline/night-cycle/steps/index.ts` — wire `runCrossLayerDedup` ПОСЛЕ `runMemoryDedup` (intra-layer первый, потом cross).
- `src/pipeline/night-cycle/post-steps.ts` (если используется) — wire.
- `src/pipeline/night-cycle/types.ts` — `CrossLayerResult` interface.
- `src/db/tables/memory.ts` — может потребоваться `crossLayerCandidates(layerA, layerB, threshold): Array<{a_id, b_id, similarity}>` SQL helper (raw SQL stays in db/tables per layer-boundary).
- `src/repositories/memory.repo.ts` — pass-through.
- `tests/night-cycle-cross-layer-dedup.test.ts` — **NEW** ≤300 LOC. ≥6 кейсов.
- `docs/02-audit.md` — `### MEM-16 ✅ cross-layer dedup + archive→shared promote (закрыто M-09)`.
- `docs/tasks/memory-v2/M-09-cross-layer-dedup.md` (этот) — Status DONE.

**НЕ трогать:**
- Migrations 1-15.
- Intra-layer dedup `memory-dedup.ts` (M-06-era) — оставить как есть, M-09 — separate step.
- `linkRelated` extractor hook (M-05) — это insert-time, M-09 — night-cycle.
- `runReflect` (M-06) — это context→shared LLM-driven promotion; M-09 это pure-cosine archive→shared (no LLM).

## Изменение

### Cross-layer pairs

3 layer combinations:
- `context ↔ archive`: thresh 0.92 — context (session-scoped) обычно более свежий, но archive имеет более старый duplicate. Direction: context → archive (старый → новый, supersede archive ← context).
- `archive ↔ shared`: thresh 0.92 — fact мигрировал в shared через reflect (M-06), но archive копия осталась. Direction: archive → shared (supersede archive ← shared).
- `context ↔ shared`: thresh 0.92 — fresh context promoted in reflect, но старая context копия осталась. Direction: context → shared (supersede context ← shared).

Direction = "куда указывает supersede". Edge `kind='supersedes'`, `src_id` = старая копия (помечена как replaced), `dst_id` = живая копия.

### Promote criteria

archive row promoted to shared when:
- `access_count ≥ ARCHIVE_PROMOTE_MIN_ACCESS` (default 5, env)
- `confidence ≥ ARCHIVE_PROMOTE_MIN_CONFIDENCE` (default 0.7, env)
- NO existing shared row с cosine ≥ 0.85 same category (skip-guard, как M-06 reflect)

После promote:
- `MemoryService.insertShared({ category, content, kind: 'semantic', confidence, source: 'archive-promote' })` — atomic embed-first.
- `linkEdge(archive_id, 'archive', new_shared_id, 'shared', 'derives', 1.0)`.
- `markSuperseded(archive_id, 'archive', new_shared_id)` (опционально — уж точно после M-12 archive имеет confidence column, но НЕ имеет superseded_by; **leave archive не-superseded**, иначе ломается M-09 idempotency на rerun).

### SQL helper `crossLayerCandidates`

Для каждой пары layers — JOIN через vec_embeddings:
```sql
WITH la AS (
  SELECT id FROM <table_a> WHERE status='active' AND superseded_by IS NULL
),
lb AS (
  SELECT id FROM <table_b> WHERE status='active' AND superseded_by IS NULL
)
SELECT a.id AS a_id, b.id AS b_id
  FROM la a, lb b
 WHERE a.id <> b.id;  -- candidate pairs, then JS-side cosine on vec_embeddings
```
NB: archive не имеет superseded_by — пропустить эту проверку для archive. cosine compute в JS через vec_embeddings (не SQL — sqlite-vec returns L2 на ненорм-векторах per audit).

Optimization: limit candidate set to most recent N=200 per layer (env `CROSS_LAYER_DEDUP_LIMIT`) чтобы не делать O(N²).

### Step shape

```ts
export async function runCrossLayerDedup(deps: {...}): Promise<CrossLayerResult> {
  const log = deps.log; // child("night.cross-layer")
  if (process.env.CROSS_LAYER_DEDUP_ENABLED === 'false') return zero;
  let pairs_examined = 0, supersedes_added = 0, promoted_to_shared = 0, errors = 0;
  // 1. context↔archive
  // 2. archive↔shared
  // 3. context↔shared
  // 4. archive→shared promote pass
  log.info(`done: pairs=${pairs_examined} supersedes=${supersedes_added} promoted=${promoted_to_shared} errors=${errors}`);
  return { pairs_examined, supersedes_added, promoted_to_shared, errors };
}
```

Errors swallowed → counted, не throw. Each pair processed independently.

### Edge weight

Constant 1.0 (consistent с M-05 / M-06 / M-10).

## Тесты

`tests/night-cycle-cross-layer-dedup.test.ts`:

1. **No candidates → zeros** — empty layers → step returns all-zero result.
2. **context↔archive supersede** — seed 2 rows similar content (cos≥0.92) one in each layer → step adds supersedes edge.
3. **archive↔shared supersede** — same.
4. **context↔shared supersede** — same.
5. **archive→shared promote** — archive row с access_count=10, confidence=0.8 → step inserts shared_memory row + derives edge. Skip-guard: если уже есть похожий shared row → no insert.
6. **Below threshold cos < 0.92 → no supersede** — pair с low similarity → skipped.
7. **Below access threshold → no promote** — archive row access=2 → skipped.
8. **`CROSS_LAYER_DEDUP_ENABLED=false` → all zeros**.

Test DB = `data/test-mem9-crosslayer.db`.

## Приёмка (machine-checkable)

1. `bunx tsc --noEmit` → exit 0.
2. `bun test ./tests/night-cycle-cross-layer-dedup.test.ts` → all green.
3. `bun test` → ≥746 pass, 0 fail.
4. `grep -n "runCrossLayerDedup\|cross-layer" src/pipeline/night-cycle/steps/cross-layer-dedup.ts src/pipeline/night-cycle/steps/index.ts` → ≥2 hits.
5. `grep -n "ARCHIVE_PROMOTE_MIN_ACCESS\|ARCHIVE_PROMOTE_MIN_CONFIDENCE\|CROSS_LAYER_DEDUP_ENABLED" src/pipeline/night-cycle/steps/cross-layer-dedup.ts` → ≥3 hits.
6. M-09 plan file Status: DONE.

## Out of scope

- Cross-layer LLM-based merge (используется только cosine + access threshold).
- shared→archive demotion — out (shared это global, no demote).
- Auto-cleanup superseded archive — out (UI/admin manual).
- Tuning thresholds (0.92/5/0.7) — A/B follow-up.
- Bulk batch processing на 100k+ rows — perf задача.

---

**Status:** DONE
