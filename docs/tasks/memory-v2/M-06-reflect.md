# M-06 · Reflect step (CoALA episodic→semantic consolidation)

**Tier:** P1 · **Effort:** M · **Deps:** M-02 (access tracking) + M-05 (edges) — landed · **Status:** DONE (2026-04-26)
**Migration assignment:** **none** (pure code — uses existing tables only).

## Цель

CoALA (Cognitive Architectures for LLM Agents, arXiv 2309.02427) предлагает разделение memory на episodic (events) / semantic (facts) / procedural (skills) и **reflect**-механизм: периодически агент просматривает episodic-память и генерирует semantic-факты по повторяющимся паттернам. Subbrain'у это нужно: layer2_context = episodic-substrate, shared_memory = semantic, но автоматического promote'а context patterns → shared нет. Memos накапливаются, но обобщения не выделяются.

После M-06: night-cycle step `reflect.ts`. Раз в сутки:
1. Группирует `layer2_context` rows по `category` где `access_count ≥ 3` (часто-юзаемые) и `created_at` старше 24h (фильтрует свежак, который ещё не "осел").
2. Для каждой группы (≥3 rows) — LLM call (`memory` role): "Извлеки обобщающий факт из этих context-записей. Если общего паттерна нет — отвечай null."
3. Если получили fact — embed + insert в `shared_memory` через `MemoryService.insertShared` (M-01 закрыл, atomic). Edges `kind='derives'` от каждого исходного context-row к новому shared-row через `MemoryDB.linkEdge` (M-05).
4. Skip-guard: cosine ≥ 0.85 со существующим shared row → не создавать дубль (использовать `dedupe.ts` от M-06-era или прямой vec-search).

Foundation для **M-09** (cross-layer dedup использует те же edges) + **M-11** (sleep-time block rewriter переписывает persona-блоки в layer1, опирается на reflect-stable shared rows).

## Файлы (scope-lock)

- `packages/agent/packages/agent/packages/agent/packages/agent/src/pipeline/night-cycle/steps/reflect.ts` — **NEW** ≤200 LOC. Step функция `runReflect(deps): Promise<ReflectResult>` где `ReflectResult = { groups_examined, facts_promoted, edges_created, llm_failures }`. Использует:
  - `memory.searchContext` (или прямой query) для групп по category с `access_count >= 3` и `created_at < now - 86400`. Фильтр `activeOnly:true` + `notStale:true` (от M-06-era schema).
  - `router.chat({ model: "memory", messages: [...] })` через `MODEL_MAP` (single-source, не hardcode).
  - `memoryService.insertShared({ category, content, kind: 'semantic', confidence, source: 'reflect' })` — `kind='semantic'` явно (M-07 mapping не нужен — это уже semantic по природе).
  - `memory.linkEdge(srcId, 'context', newSharedId, 'shared', 'derives', 1.0)` для каждого исходного context.
  - `rag.search` ИЛИ `dedupe` от M-06-era (если есть) для cosine ≥ 0.85 skip-guard.
- `packages/agent/packages/agent/packages/agent/packages/agent/src/pipeline/night-cycle/steps/index.ts` — добавить `runReflect` в order, **после** `runMemoryDedup` и `decaySalience` (чтобы reflect видел уже задедуплицированные + decayed rows).
- `packages/agent/packages/agent/packages/agent/packages/agent/src/pipeline/night-cycle/post-steps.ts` (если используется для wiring) — wire.
- `packages/agent/packages/agent/packages/agent/packages/agent/src/pipeline/night-cycle/types.ts` — `ReflectResult` если нужен для общего типа.
- `tests/night-cycle-reflect.test.ts` — **NEW** ≤300 LOC. ≥6 кейсов.
- `docs/02-audit.md` — `### MEM-12 ✅ reflect step (CoALA, закрыто M-06)`.
- `docs/tasks/memory-v2/M-06-reflect.md` — Status DONE.

**НЕ трогать:**
- Существующие миграции 1-14.
- Hippocampus (`post/extractors.ts`) — reflect это night-cycle, не post-extraction.
- M-03 decay logic / M-05 edges schema.
- LLM model selection — использовать `MODEL_MAP.memory` (gpt-5.1+MiniMax) через router.

## Изменение

### Group selection SQL

```sql
SELECT category, COUNT(*) as n, GROUP_CONCAT(id) as ids
  FROM layer2_context
 WHERE access_count >= ?  -- ACCESS_THRESHOLD (default 3, env REFLECT_MIN_ACCESS)
   AND created_at < ?     -- now - 86400 (older than 24h)
   AND status = 'active'
   AND superseded_by IS NULL
   AND (expires_at IS NULL OR expires_at > ?)  -- not stale
 GROUP BY category
HAVING n >= ?              -- GROUP_THRESHOLD (default 3, env REFLECT_MIN_GROUP)
 ORDER BY n DESC
 LIMIT ?                   -- MAX_GROUPS (default 5, env REFLECT_MAX_GROUPS)
```

`category` filter on whitelist (`WHITELIST_CONTEXT` из validators.ts: `project|decision|bug|architecture|learning`) — не reflect'им garbage.

### LLM prompt structure

```
System: "You are a memory consolidator. Given a list of related context-memo entries from the same category, extract one consolidated semantic fact that captures the recurring pattern. If there is no clear pattern, respond with exactly: NULL."

User: "Category: {category}\nEntries:\n1. {content_1}\n2. {content_2}\n...\n\nReturn one of:\n- A single sentence ≤200 chars stating the consolidated fact.\n- The literal string NULL."
```

Parse response:
- Trim. If `=== "NULL"` or empty → skip group.
- Else → use as new shared content.

`temperature: 0.1` (factual extraction). `max_tokens: 250`. AbortSignal с timeout 30s. На ошибку — `log.warn` + skip group.

### Skip-guard

Перед `insertShared` проверить: есть ли уже shared row с `category={category}` и cosine ≥ 0.85?
- `rag.search({ query: candidate, layers: ['shared'], rerankTopN: 1, skipRerank: true })` (cheap).
- Если top-1 score (нормализованный) ≥ 0.85 → skip.
- Иначе → insertShared.

Альтернативно использовать `post/dedupe.ts` если оно cosine-based и подходит.

### Edges create

После успешного insertShared (`newId` returned from `MemoryService.insertShared`):
```ts
for (const srcContextId of group.ids) {
  memory.linkEdge(srcContextId, 'context', newId, 'shared', 'derives', 1.0);
}
```

Constants on weight (как M-05 fix-round) — existence-based, не strength.

### Step shape

```ts
// pseudo
export async function runReflect(deps: {
  memory: MemoryDB;
  memoryService: MemoryService;
  rag: RAGPipeline;
  router: ModelRouter;
  log: RequestLogger;
}): Promise<ReflectResult> {
  const log = deps.log; // assume already child("night.reflect")
  const groups = deps.memory.db.query(GROUP_SELECTION_SQL).all(...);
  let facts_promoted = 0, edges_created = 0, llm_failures = 0;
  for (const g of groups) {
    try {
      const fact = await reflectGroup(g, deps);
      if (!fact) continue;
      const dup = await checkDup(fact, g.category, deps);
      if (dup) continue;
      const newId = await deps.memoryService.insertShared({
        category: g.category, content: fact, kind: 'semantic',
        confidence: 0.7, source: 'reflect',
      });
      for (const srcId of g.ids.split(',')) {
        deps.memory.linkEdge(srcId, 'context', newId, 'shared', 'derives', 1.0);
        edges_created++;
      }
      facts_promoted++;
    } catch (err) {
      llm_failures++;
      log.warn("night.reflect", `group ${g.category} failed: ${(err as Error).message}`);
    }
  }
  log.info("night.reflect", `done: groups=${groups.length} promoted=${facts_promoted} edges=${edges_created} failures=${llm_failures}`);
  return { groups_examined: groups.length, facts_promoted, edges_created, llm_failures };
}
```

Env knobs: `REFLECT_MIN_ACCESS=3`, `REFLECT_MIN_GROUP=3`, `REFLECT_MAX_GROUPS=5`, `REFLECT_ENABLED=true` (default; `false` → step no-op).

## Тесты

`tests/night-cycle-reflect.test.ts` (`bun:test`, `data/test-mem6-reflect.db`):

1. **No groups → no-op** — пустой context → step returns `{groups_examined:0, facts_promoted:0, edges_created:0, llm_failures:0}`.
2. **Below access threshold → skip** — context rows с access_count=2 → skip (threshold default 3).
3. **Below group threshold → skip** — 2 rows category=project access_count=5 → skip (group min 3).
4. **Successful promote** — seed 3 context rows category=project access≥3, mock router возвращает "Project Subbrain uses Bun runtime" → insertShared called с kind='semantic' + 3 derives edges от source contexts.
5. **LLM returns NULL → no insert** — mock router возвращает "NULL" → no shared row, no edges.
6. **Skip-guard на existing shared** — pre-seed shared row с близким cosine; group reflect возвращает похожий fact → skip via dedupe.
7. **LLM failure → counted, не падает step** — mock router throws → llm_failures++, других groups process'ится дальше.
8. **REFLECT_ENABLED=false → step no-op** — env-flag → returns `{groups_examined:0, facts_promoted:0, edges_created:0, llm_failures:0}`, не делает SQL.
9. **Edges weight constant 1.0** — verify `memory_edges.weight = 1.0` для созданных derives.

Mocking router: использовать стиль M-04/M-05 — `router = { raw: { embed, rerank }, scheduleRaw, chat: async ({messages}) => ... }`.

## Приёмка (machine-checkable)

1. `bunx tsc --noEmit` → exit 0.
2. `bun test tests/night-cycle-reflect.test.ts` → all green.
3. `bun test` → ≥700 pass, 0 fail (baseline после wave-2).
4. `grep -n "runReflect\|night.reflect" packages/agent/packages/agent/packages/agent/src/pipeline/night-cycle/steps/reflect.ts packages/agent/packages/agent/packages/agent/src/pipeline/night-cycle/steps/index.ts packages/agent/packages/agent/packages/agent/src/pipeline/night-cycle/post-steps.ts` → ≥3 hits.
5. `grep -n "REFLECT_ENABLED\|REFLECT_MIN_ACCESS\|REFLECT_MIN_GROUP" packages/agent/packages/agent/packages/agent/src/pipeline/night-cycle/steps/reflect.ts` → ≥3 hits.
6. `docs/tasks/memory-v2/M-06-reflect.md` Status: DONE.

## Out of scope

- Cross-category reflection (project + bug → strategy). M-06.1 follow-up.
- Promote shared → archive (long-term consolidation). Out.
- LLM-based contradiction detection (kind='contradicts' edges). M-05.2.
- Tuning constants (3/3/5/0.85). A/B follow-up.
- Reflect на shared layer (semantic→procedural). Out.
- UI просмотр reflect-history. Out.

---

**Status:** DONE (2026-04-26)
