# M-10 · Public MCP curation tools (`memory_link/supersede/promote/reflect`)

**Tier:** P2 · **Effort:** S · **Deps:** M-05 (edges) — landed · **Status:** DONE (commit `df041e4` + fix-round `5e00513`: promote-category-required, promote-confidence=0.8, categoryFilter unbounded)
**Migration assignment:** **none** (pure MCP registry — no schema changes).

## Цель

После M-05 у нас есть `memory_edges` table + `MemoryDB.linkEdge` API, но через MCP агенты могут сейчас только **читать** memory (`memory_search`, `memory_log_search`) и **писать новые** (`memory_write`, `memory_delete`). Curation operations (linking + lifecycle) — internal-only через hippocampus / night-cycle.

После M-10: 4 новых MCP tool'а в `agent-only` scope (доступны автономным агентам, hippocampus, free-agent — но не public REST):

1. **`memory_link`** — добавить explicit edge между двумя memos. `(src_id, src_layer, dst_id, dst_layer, kind)` где kind ∈ EdgeKind union. Weight = const 1.0 (consistent с M-05).
2. **`memory_supersede`** — пометить memo как superseded by another. Updates `superseded_by` column (M-07-era schema на shared/context) + создаёт edge `kind='supersedes'` для audit trail.
3. **`memory_promote`** — promote memo из одного layer в другой (типичный кейс: context → shared когда фактически уже не session-scoped). Insert в target layer + edge `kind='derives'` от source. Source НЕ удаляется (back-compat).
4. **`memory_reflect`** — manual trigger для night-cycle reflect step (M-06) на конкретную category. Возвращает promoted_count + edges_created.

Foundation для **M-09** (cross-layer dedup использует supersede/promote через MCP) + дает агентам возможность курировать собственный граф (Letta-style explicit memory management).

## Файлы (scope-lock)

- `src/mcp/registry/memory.tools.ts` — добавить 4 tool registrations (TypeBox schema + handler). Каждый `scope: "agent-only"`.
- `src/mcp/tools/memory-tools.ts` — domain logic для 4 ops. `link`, `supersede`, `promote`, `reflect` методы. ~120 LOC suma. Используют существующие primitives: `MemoryDB.linkEdge` (M-05), `MemoryService.insertShared` (M-01), `runReflect` (M-06).
- `src/mcp/executor.ts` — пробросить новые ops в `ToolExecutor`.
- `src/db/index.ts` — facade methods для supersede / promote если нужны (вряд ли — service layer достаточен).
- `tests/mcp-curation-tools.test.ts` — **NEW** ≤200 LOC. ≥8 кейсов.
- `docs/02-audit.md` — `### MEM-15 ✅ public MCP curation tools (закрыто M-10)`.
- `docs/tasks/memory-v2/M-10-public-curation-tools.md` (этот) — Status DONE.

**НЕ трогать:**
- Schema (M-05 edges + M-07 superseded_by уже есть).
- M-06 reflect step — `memory_reflect` MCP tool делегирует в существующий `runReflect`, не reimplement.
- M-05 linkRelated automatic hook (post-extractor) — manual `memory_link` это complementary, не replacement.

## Изменение

### `memory_link`

```ts
registry.register({
  name: "memory_link",
  description: "Add typed edge between two memory rows (graph curation). Edge kinds: derives, relates, contradicts, supersedes.",
  scope: "agent-only",
  input: t.Object({
    src_id: t.String(),
    src_layer: t.Union([t.Literal("context"), t.Literal("archive"), t.Literal("shared")]),
    dst_id: t.String(),
    dst_layer: t.Union([t.Literal("context"), t.Literal("archive"), t.Literal("shared")]),
    kind: t.Union([t.Literal("derives"), t.Literal("relates"), t.Literal("contradicts"), t.Literal("supersedes")]),
  }),
  handler: (args, ctx) => {
    ctx.executor.memoryDb.linkEdge(args.src_id, args.src_layer, args.dst_id, args.dst_layer, args.kind, 1.0);
    return { success: true, data: { linked: true } };
  },
});
```

Idempotent — `linkEdge` использует `INSERT OR IGNORE` на PK (M-05). Validation (existence src/dst) — optional; если row не существует, edge создан orphan-style. Можно добавить sanity check через `getShared/getContext/getArchive`.

### `memory_supersede`

```ts
input: t.Object({
  old_id: t.String(),
  old_layer: t.Union([t.Literal("context"), t.Literal("shared")]),  // archive не имеет superseded_by
  new_id: t.String(),
  new_layer: t.Union([t.Literal("context"), t.Literal("shared")]),
}),
handler: (args, ctx) => {
  // 1. Update superseded_by column on old row.
  ctx.executor.memoryDb.updateSuperseded(args.old_id, args.old_layer, args.new_id);
  // 2. Insert audit edge.
  ctx.executor.memoryDb.linkEdge(args.old_id, args.old_layer, args.new_id, args.new_layer, "supersedes", 1.0);
  return { success: true };
}
```

`updateSuperseded` — facade на `MemoryDB` для existing column updates (если нет — добавить thin pass-through).

### `memory_promote`

```ts
input: t.Object({
  src_id: t.String(),
  src_layer: t.Literal("context"),  // только context → shared в M-10
  target_layer: t.Literal("shared"),
}),
handler: async (args, ctx) => {
  const src = ctx.executor.memoryDb.getContext(args.src_id);
  if (!src) return { success: false, error: "src not found" };
  const newId = await ctx.executor.memoryService.insertShared({
    category: src.title || "general",
    content: src.content,
    tags: src.tags,
    source: "promote",
    confidence: src.confidence,
    kind: "semantic",  // explicit
  });
  ctx.executor.memoryDb.linkEdge(args.src_id, "context", newId, "shared", "derives", 1.0);
  return { success: true, data: { id: newId } };
}
```

Source НЕ удаляется. Caller волен потом вызвать `memory_supersede` или `memory_delete` если нужно cleanup.

### `memory_reflect`

```ts
input: t.Object({
  category: t.Optional(t.String()),  // если задан — reflect только для этой category
  dryRun: t.Optional(t.Boolean()),   // для testing — вернуть groups без insertShared
}),
handler: async (args, ctx) => {
  // Делегирует в runReflect (M-06). Если category — фильтруем groups внутри runReflect (требует extension в M-06's group-selection SQL).
  const result = await runReflect({
    memory: ctx.executor.memoryDb,
    memoryService: ctx.executor.memoryService,
    rag: ctx.executor.rag,
    router: ctx.executor.router,
    log: ctx.log.child("mcp.reflect"),
    categoryFilter: args.category,
    dryRun: args.dryRun,
  });
  return { success: true, data: result };
}
```

Requires M-06's `runReflect` to accept optional `categoryFilter` + `dryRun` params. Если такой extension в M-06 нет — добавить минимальный (≤10 LOC change в reflect.ts), либо ограничить M-10 без category-filter (default behavior).

## Тесты

`tests/mcp-curation-tools.test.ts`:

1. **`memory_link` creates edge** — call с (src, dst, "relates") → SELECT memory_edges → 1 row.
2. **`memory_link` idempotent on PK collision** — same call дважды → no throw, no duplicate.
3. **`memory_link` invalid kind → 422** — `kind: "invalid"` отвергается TypeBox.
4. **`memory_supersede` updates column + edge** — pre-seed shared row; call supersede → SELECT shows superseded_by=new_id, memory_edges has kind='supersedes' edge.
5. **`memory_promote` context → shared with derive edge** — pre-seed context row; call promote → new shared row exists, edge kind='derives' src=context dst=shared.
6. **`memory_promote` missing source → error** — call with non-existent src_id → returns `{success:false}`.
7. **`memory_reflect` delegates to runReflect** — mock router, seed 3 context rows category=project access≥3 → reflect call → returns `{groups_examined, facts_promoted, edges_created}`.
8. **`memory_reflect` dryRun does NOT insert** — same setup with `dryRun: true` → groups examined but no shared row added.
9. **All tools `scope: "agent-only"`** — sanity grep / registry assertion: public REST не получает доступ.
10. **TypeBox layer enum** — `src_layer: "log"` → 422 (log is not a curation target).

## Приёмка (machine-checkable)

1. `bunx tsc --noEmit` → exit 0.
2. `bun test tests/mcp-curation-tools.test.ts` → all green.
3. `bun test` → ≥725 pass, 0 fail.
4. `grep -n "memory_link\|memory_supersede\|memory_promote\|memory_reflect" src/mcp/registry/memory.tools.ts` → ≥4 hits.
5. `grep -n 'scope: *"agent-only"' src/mcp/registry/memory.tools.ts` → ≥4 (старые `memory_log_search` от M-04 + новые 4).
6. M-10 plan file Status: DONE.

## Out of scope

- Public REST endpoints для curation — privacy concern (raw memo manipulation). Только agent-only.
- `memory_unlink` (delete edge) — out, мало юзкейсов (используй memory_delete если row mid-removed → cascade soft).
- `memory_promote` shared → archive — out (archive это compressed-by-night-cycle, не manual promote).
- UI визуализация edges — отдельная задача.
- Bulk operations (link many in one call) — out.
- Permission/ACL различение между агентами — out (все agent-only equally).

---

**Status:** DONE (commit `df041e4` + fix-round `5e00513`)
