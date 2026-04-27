# M-14 · Admin REST + UI surface for memory_edges

**Tier:** P2 · **Effort:** S · **Deps:** M-05 (edges API) — landed; M-13 (MemoryService linkRelated wiring) — recommended for full coverage but not blocking · **Status:** DONE
**Migration assignment:** **none** (no schema change, read-only surface).

## Цель

После M-05/M-05.1/M-05.2 + M-13 в DB живут `memory_edges` с kind ∈ {relates, derives, supersedes, contradicts} (+ weight). Но:
- `src/routes/memory.ts` — 0 endpoints для edges.
- `web/app/` — 0 references на `memory_edges`.

Значит куратор / админ через UI не видит ни relates-граф, ни contradicts-конфликты — вся M-05.* работа невидима. M-14 закрывает: read-only REST endpoints + минимальная UI sidebar в `MemoryRow.vue` показывает related rows + contradicts (если есть).

После M-14:
- `GET /v1/memory/edges?from=<id>&fromLayer=<layer>&kinds=<csv>` → `{ items: EdgeRow[], total: number }`.
- `GET /v1/memory/edges/related?id=<id>&layer=<layer>&kinds=<csv>` → `{ items: { id, layer, kind, weight }[], total }` (рассрочена через `MemoryRepository.getRelated` или прямой JOIN).
- `MemoryRow.vue` показывает collapsible "🔗 Edges" секцию: список related rows (id-prefix + kind + weight), highlight contradicts красным.

NO мутации (delete/update edge) в M-14 — только read. Curation tools (`memoryEdgesCuration`) уже делают writes; UI delete/update edges = follow-up.

## Файлы (scope-lock)

- `src/routes/memory.ts` — добавить 2 endpoint'а (≤30 LOC). Use existing `paginate()` envelope helper. Под `authMiddleware`.
- `src/repositories/edges.repo.ts` — если `getRelated` не подходит (returns `{id,layer}[]` без kind/weight), добавить `getRelatedDetailed(id, layer, kinds?)` returning `EdgeRow[]`. ≤20 LOC delta. **Если уже подходит** — skip (use existing).
- `web/app/composables/useMemory.ts` — добавить `fetchEdges(id, layer)` API call. ≤15 LOC.
- `web/app/components/MemoryRow.vue` — collapsible "🔗 Edges" section. Lazy-load on expand. ≤40 LOC delta.
- `tests/routes-memory-edges.test.ts` — **NEW** файл (≤150 LOC). ≥4 cases (auth, list-from, list-related, kind filter).
- `docs/02-audit.md` — `### MEM-23 ✅ edges admin surface (закрыто M-14)`.
- `docs/tasks/memory-v2/M-14-edges-admin-surface.md` (этот) — Status DONE.

**НЕ трогать:**
- `src/db/tables/edges.ts` — schema layer, M-05 territory.
- `src/mcp/tools/memory-curation-tools.ts` (write surface через MCP — already exists).
- M-05/M-05.1/M-05.2/M-13 plan files / extractors / link-related.ts.
- Migrations / schema / triggers.
- Edge weight semantics (relates=1.0, contradicts=LLM-conf).

## Изменение

### REST endpoints

`src/routes/memory.ts` — два GET:

```ts
.get(
  "/edges",
  ({ query }) => {
    const from = String(query.from ?? "");
    const fromLayer = String(query.fromLayer ?? "");
    const kinds = parseKindsCsv(query.kinds);
    if (!from || !fromLayer) {
      throw new HttpError(400, "from + fromLayer required");
    }
    const items = memoryService.getEdgesFromSrc(from, fromLayer, kinds);
    return paginate(items, items.length);
  },
  {
    query: t.Object({
      from: t.String({ minLength: 1 }),
      fromLayer: t.Union([t.Literal("context"), t.Literal("shared"), t.Literal("archive")]),
      kinds: t.Optional(t.String()),
    }),
    detail: { summary: "List edges from a memory row" },
  },
)
.get(
  "/edges/related",
  ({ query }) => {
    const id = String(query.id ?? "");
    const layer = String(query.layer ?? "");
    const kinds = parseKindsCsv(query.kinds);
    if (!id || !layer) throw new HttpError(400, "id + layer required");
    const items = memoryService.getRelatedDetailed(id, layer, kinds);
    return paginate(items, items.length);
  },
  {
    query: t.Object({
      id: t.String({ minLength: 1 }),
      layer: t.Union([t.Literal("context"), t.Literal("shared"), t.Literal("archive")]),
      kinds: t.Optional(t.String()),
    }),
    detail: { summary: "List related rows by edge kind(s)" },
  },
)
```

`parseKindsCsv` — module-private helper:
```ts
function parseKindsCsv(raw: unknown): EdgeKind[] | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  const allowed = new Set<EdgeKind>(["relates", "derives", "supersedes", "contradicts"]);
  return raw.split(",").map(s => s.trim()).filter((k): k is EdgeKind => allowed.has(k as EdgeKind));
}
```

### MemoryService delegation

Add thin pass-through methods:
```ts
getEdgesFromSrc(srcId: string, srcLayer: string, kinds?: EdgeKind[]): EdgeRow[] {
  return this.repo.edges.getEdgesFromSrc(srcId, srcLayer as any, kinds);
}
getRelatedDetailed(id: string, layer: string, kinds?: EdgeKind[]): RelatedEdge[] {
  return this.repo.edges.getRelatedDetailed(id, layer as any, kinds);
}
```

If `repo.edges` is not exposed — service touches it via existing facade. Subagent inspects current `MemoryRepository` shape; if `edges` sub-repo is private, expose via getter or add direct method. ≤8 lines delta.

### UI

`web/app/components/MemoryRow.vue`:
- Add collapsible "🔗 Edges" toggle button.
- On expand, call `useMemory().fetchEdges(row.id, row.layer)` → display:
  ```
  → relates: a1b2c3 [w=1.0]
  → contradicts: 9f8e7d [w=0.85]  (red)
  ← derives: 5e4d3c [w=1.0]       (incoming, dashed)
  ```
- Cache result in row-local ref so re-expand doesn't refetch.

`web/app/composables/useMemory.ts`:
```ts
async function fetchEdges(id: string, layer: string) {
  const out = await Promise.all([
    api(`/v1/memory/edges?from=${encodeURIComponent(id)}&fromLayer=${layer}`),
    api(`/v1/memory/edges?from=${encodeURIComponent(id)}&fromLayer=${layer}&kinds=contradicts,supersedes`),
  ]);
  // ... merge dedupe ...
}
```

Actually simpler: single endpoint call, UI filters by kind for display.

### Edge cases handled

- **No edges** → empty list, UI shows "no edges".
- **Invalid kinds CSV** → silently filtered (drop unknowns); empty kinds → all kinds returned.
- **Row deleted but edges still exist** (M-05 doesn't cascade-delete edges) → list shows orphan dst_id; UI handles gracefully (not a navigation link).
- **Auth missing** → 401 (covered by `authMiddleware`).
- **Pagination:** edges per row are ≤O(10) typically (top-3 relates + few contradicts), so no LIMIT needed; envelope still uses `paginate(items, items.length)` for consistency.

## Тесты

`tests/routes-memory-edges.test.ts` (new):

1. **GET /edges 401 without auth** — no Bearer → 401.
2. **GET /edges returns relates from seed** — seed shared row + linkEdge to another → 200 + `items[0].kind === "relates"`.
3. **GET /edges?kinds=contradicts filters** — seed both relates + contradicts edges → `?kinds=contradicts` returns only contradicts.
4. **GET /edges/related returns dst rows** — seed two shared rows + linkEdge → endpoint returns dst row id + layer.
5. **(bonus) GET /edges from row with 0 edges** → `{ items: [], total: 0 }`.
6. **(bonus) Invalid fromLayer** → 422 from TypeBox.

Test DB `data/test-mem14-edges.db`. App boot via existing test helper.

## Приёмка (machine-checkable)

1. `bunx tsc --noEmit` → exit 0.
2. `bun test tests/routes-memory-edges.test.ts` → all green.
3. `bun test` → ≥800 pass, 0 fail (depends on M-13 baseline; if M-13 lands first → 800+; standalone → 795+4=799).
4. `grep -n "/edges" src/routes/memory.ts` → ≥2 hits (2 routes).
5. `grep -n "fetchEdges\|edges" web/app/components/MemoryRow.vue` → ≥1 hit.
6. M-14 plan file Status: DONE.
7. MEM-23 entry в `docs/02-audit.md`.

## Out of scope

- Edge mutations (delete/update edge) через REST — admin curation tools на MCP-уровне уже умеют (`memoryEdgesCuration`); UI follow-up.
- Graph visualization (force-directed / sigma.js) — only flat list for now.
- Cross-layer edge navigation (click → jump to related row) — out (UI shows id-prefix only).
- Edge weight histogram / aggregate stats — out.
- `archive` layer edges — schema supports it (CHECK), но архив reads через `getArchive`, проверяет subagent если callable; иначе drop archive support и оставить context|shared.
- Bulk-delete orphan edges (dst row gone) — out (M-05 didn't cascade; separate cleanup task).

---

**Status:** DONE (2026-04-27)

## Реализация (заметки)

- `MemoryService.getEdgesFromSrc` / `getRelatedDetailed` — pass-through на `memoryDb` facade (`getEdgesFromSrc`, `getRelated(id, layer, depth=1, kinds)`). 3-arg test ctor с `memoryDb=null` → возврат `[]`. Существующий `getRelated` уже отдаёт `{id, layer, kind, weight}[]` — `getRelatedDetailed` не понадобился в repo, just method-name alias on service.
- `routes/memory.ts` — 2 GET под `authMiddleware` через `paginate(loader, query)`. Loader делает in-memory slice (edges per row ≤ O(10)), envelope `{items,total,page,page_size}`.
- TypeBox enums: `EDGE_LAYER = context|shared|archive`, `EDGE_KINDS_ALLOWED` whitelist для `kinds` CSV. Bogus layer / missing required field → 422 через `code === "VALIDATION"` в central onError.
- `useMemory.ts` — `fetchEdges(id, layer)` arrow, hits `/edges/related?page_size=100`. `EdgeInfo` exported.
- `MemoryRow.vue` — collapsible "🔗 ▸/▾" toggle на rows с `__kind ∈ {context, shared, archive}` и валидным `id`. Lazy-load on first expand, cached в row-local `ref`. Contradicts highlighted `text-red-400`.
- `tests/routes-memory-edges.test.ts` (227 LOC) — 10 кейсов: 2× auth-401, 2× 422 validation, list outbound + filter, empty envelope, 1-hop related (out + in), kind filter on related.

## Acceptance run (2026-04-27)

- `bunx tsc --noEmit` → exit 0
- `bun test tests/routes-memory-edges.test.ts` → 10 pass / 0 fail
- `bun test` → **810 pass / 0 fail** (800 baseline + 10 new)
- `grep -n "/edges" src/routes/memory.ts` → 2 hits ✅
- `grep -n "fetchEdges\|edges" web/app/components/MemoryRow.vue` → 21 hits ✅
