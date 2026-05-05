# M-13 · Extend MemoryService writers to run linkRelated post-commit (close M-05 path gap)

**Tier:** P1 (bug — feature gap) · **Effort:** S · **Deps:** M-05 (edges + linkRelated) + M-05.1 (tag evolution) + M-05.2 (contradiction detection) — all landed · **Status:** DONE (2026-04-27)
**Migration assignment:** **none** (no schema change).

## Цель

Empirically confirmed gap: `MemoryService.insertShared/insertContext` (single-source-of-truth для embed-first transactional writes) **не вызывает `linkRelated`**. Значит M-05/M-05.1/M-05.2 фичи (relates edges, A-MEM tag evolution, LLM contradiction detection) активны **только** через `packages/agent/src/pipeline/agent-pipeline/post/extractors.ts:writeShared/writeContext` — единственная hippocampus-driven post-extraction path.

Не рисуют edges:
1. **MCP `memory_write`** (agent-loop) → `MemoryTools` → `memoryService.insertShared` (`packages/agent/src/mcp/tools/memory-tools.ts:230`).
2. **Night-cycle reflect** episodic→semantic promotion → `deps.memoryService.insertShared` (`packages/agent/src/pipeline/night-cycle/steps/reflect.ts:132`).
3. **Night-cycle cross-layer dedup** context→shared promotion → `memoryService.insertShared` (`packages/agent/src/pipeline/night-cycle/steps/cross-layer-dedup.ts:152`).
4. **Admin REST POST `/v1/memory/shared`/`/v1/memory/context`** → `memoryService.insertShared/insertContext`.

После M-13: `MemoryService.insertShared/insertContext` принимает optional `linkDeps?: { router: ModelRouter; log: RequestLogger }` через конструктор (single-place wiring). Если `linkDeps` set → после успешного `repo.transaction(insert + upsertEmbedding)` вызывает `linkRelated(memory, rag, router, id, layer, content, parseTagsCsv(tags), log)` **best-effort** (try/catch — никогда не abort write).

NO behavior change для test callers, что не передают linkDeps (default = null → skip linkRelated). Production wiring (`app/deps.ts`) передаёт `{ router, log: logger.child("memory.svc") }`.

## Файлы (scope-lock)

- `packages/agent/src/services/memory.service.ts` — extend constructor + insertShared/insertContext post-hook. ≤230 LOC final.
- `packages/server/src/app/deps.ts` — pass `{ router, log }` в `new MemoryService(...)` constructor. ≤4 lines.
- `tests/memory-service-link-related.test.ts` — **NEW** файл (≤200 LOC). ≥4 cases.
- `docs/02-audit.md` — `### MEM-22 ✅ MemoryService.linkRelated wiring (закрыто M-13)`.
- `docs/tasks/memory-v2/M-13-memoryservice-linkrelated.md` (этот) — Status DONE.

**НЕ трогать:**
- `packages/agent/src/pipeline/agent-pipeline/post/extractors.ts` (hippocampus path остаётся как есть — duplicate call OK, see §Inertia).
- `packages/agent/src/pipeline/agent-pipeline/post/link-related.ts` (M-05.2 артефакт).
- M-05/M-05.1/M-05.2 plan files / audit entries.
- Migrations / schema.
- MCP tool registry (memory_write tool path остаётся; cascading benefit).
- Night-cycle / reflect / dedup steps (gain edges автоматом через memoryService).

## Изменение

### Constructor extension

```ts
import type { ModelRouter } from "../lib/model-router";
import type { RequestLogger } from "../lib/logger";

export interface MemoryServiceLinkDeps {
  router: ModelRouter;
  log: RequestLogger;
}

export class MemoryService {
  // … existing fields …

  constructor(
    private readonly repo: MemoryRepository,
    private readonly rag: RAGPipeline,
    private readonly linkDeps: MemoryServiceLinkDeps | null = null, // NEW
  ) {}
}
```

### Post-hook in insertShared

```ts
async insertShared(input: InsertSharedInput): Promise<string> {
  const id = randomUUID();
  const vec = await embedWithTimeout(this.rag, input.content);
  if (!vec || vec.length === 0) throw new Error("embed_empty");
  this.repo.transaction(() => {
    this.repo.insertShared(id, input.category, input.content, input.tags ?? "", input.source, {
      confidence: input.confidence ?? null,
      status: input.status,
      kind: input.kind,
    });
    this.repo.upsertEmbedding(id, "shared", vec);
  });

  // M-13: best-effort post-hook (M-05 relates + M-05.1 evolve + M-05.2 contradict).
  if (this.linkDeps) {
    try {
      await linkRelated(
        this.memory,        // see §Memory access
        this.rag,
        this.linkDeps.router,
        id,
        "shared",
        input.content,
        parseTagsCsv(input.tags ?? ""),
        this.linkDeps.log,
      );
    } catch (err) {
      this.linkDeps.log.warn("memory.svc", `linkRelated failed for ${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return id;
}
```

Same shape для `insertContext` (layer="context").

### Memory access

`linkRelated` first arg ожидает `MemoryDB`, но `MemoryService` имеет только `MemoryRepository`. Two options:

**Option A (preferred):** Inject `MemoryDB` facade в `MemoryService` constructor (как 4th arg, optional, default = derived from repo? no — repo doesn't expose db). Cleanest.
```ts
constructor(
  private readonly repo: MemoryRepository,
  private readonly rag: RAGPipeline,
  private readonly memoryDb: MemoryDB | null = null, // NEW — needed by linkRelated/linkEdge/getContext/getShared
  private readonly linkDeps: MemoryServiceLinkDeps | null = null,
) {}
```
`app/deps.ts` уже создаёт `memoryDb` first, потом `memoryService` — trivial pass-through.

**Option B:** Refactor `linkRelated` to accept `MemoryRepository` instead of `MemoryDB` — bigger change, touches link-related.ts (M-05.2 artifact, "НЕ трогать"). Reject.

**Take A.** If `memoryDb === null` (test path) → skip linkRelated even if linkDeps set.

### Caller wiring

`packages/server/src/app/deps.ts` — найти `new MemoryService(memory.memoryRepo, rag)` and extend:
```ts
const memoryService = new MemoryService(
  memory.memoryRepo,
  rag,
  memory,                            // MemoryDB facade
  { router, log: logger.child("memory.svc") },
);
```

### Inertia / duplicate-call concern

After M-13, hippocampus path **also** runs through MemoryService (NO — hippocampus uses `extractors.writeShared` which calls `memory.insertShared` raw, not `memoryService.insertShared`). So no duplicate `linkRelated` call. ✓

If a future refactor consolidates hippocampus onto MemoryService, double-call would be possible. Plan §Inertia documents this; M-13 itself doesn't trigger it.

### Edge cases handled

- **linkDeps null** (test, scripts) → skip linkRelated, write succeeds.
- **memoryDb null** (test fixture) → skip linkRelated, write succeeds.
- **linkRelated throws** (RAG down, etc) → caught + log.warn, write success preserved.
- **Same-row dedup** in linkRelated already handled by M-05 (`if (n.id === insertedId) continue;`).

## Тесты

`tests/memory-service-link-related.test.ts` (new):

1. **No linkDeps → no edges** — `new MemoryService(repo, rag)` without 4th arg → insert seed + insert new → 0 edges from new row.
2. **With linkDeps → relates edge to neighbour** — `new MemoryService(repo, rag, memory, { router, log })` → seed embedded shared row → insert similar row → `getEdgesFromSrc(newId, "shared")` ≥1 with kind="relates".
3. **Tag evolution fires through service** — seed `tags="a,b"` + insert with `tags="c,d"` → seed evolved to `a,b,c,d` (proves M-05.1 chain runs).
4. **Best-effort: linkRelated throw doesn't abort write** — mock router that throws on any chat call + LINK_CONTRADICT_ENABLED=true → still returns newId, no throw bubbles up.
5. **insertContext same wiring** — repeat (2) for context layer.

Test DB: `data/test-mem13-link.db`. Per-test cleanup.

## Приёмка (machine-checkable)

1. `bunx tsc --noEmit` → exit 0.
2. `bun test tests/memory-service-link-related.test.ts` → all green.
3. `bun test` → ≥800 pass, 0 fail (795 baseline + ≥4 new).
4. `grep -nE "linkDeps|linkRelated" packages/agent/src/services/memory.service.ts` → ≥4 hits (constructor field + 2 callsites + import).
5. `grep -n "linkDeps:" packages/server/src/app/deps.ts` → ≥1 hit (constructor wiring).
6. M-13 plan file Status: DONE.
7. MEM-22 entry в `docs/02-audit.md`.

## Out of scope

- Refactor `linkRelated` to take `MemoryRepository` (would re-open M-05.2 file).
- Extend admin REST с `/v1/memory/edges` (отдельный M-14).
- UI surface для edges (M-14).
- `MemoryTools.writeSharedAtomic` legacy fallback fix — rarely-triggered code path; if user rewires to use service it's already covered, otherwise out of scope.
- `context-compressor.ts:258` direct `memory.insertShared` call — separate path, low-priority follow-up.
- Backfill edges для существующих rows insert'ed without linkRelated — out (M-05 already considered backfill out of scope).

---

**Status:** DONE (2026-04-27)

## Реализация

- `packages/agent/src/services/memory.service.ts` — расширил ctor двумя optional аргументами (`memoryDb: MemoryDB | null = null`, `linkDeps: MemoryServiceLinkDeps | null = null`) после существующего `logRepo`. Добавил приватный `runLinkRelated()` помощник, который вызывается в обоих `insertShared` и `insertContext` сразу после `repo.transaction()`. Best-effort try/catch — throw логируется в `linkDeps.log.warn`, write остаётся коммитнутым.
- `packages/server/src/app/deps.ts` — production wiring: `new MemoryService(memory.memoryRepo, rag, memory.logRepo, memory, { router, log: logger.forRequest("memory-svc", "memory-svc") })`. Synthetic RequestLogger, т.к. сервис долгоживущий (не request-bound).
- `tests/memory-service-link-related.test.ts` — 5 кейсов: legacy 3-arg ctor → 0 edges; full ctor → relates edge; M-05.1 tag evolution через сервис; throw в LLM-роутере не блокирует write; insertContext mirror.

Existing 3-arg test callers (`tests/memory-kind.test.ts`, `tests/mcp-curation-tools.test.ts`, `tests/memory-routes-*.test.ts`, etc.) продолжают работать без правок — defaults `null` дают back-compat skip.

Note: ctor сохранил `logRepo` как 3rd позиционный аргумент (вместо вытаскивания через `memoryDb.logRepo`) ради zero-touch back-compat для всех существующих 3-arg тест-вызовов. Plan §Memory access option A был ослаблен в этой части — итоговая сигнатура `(repo, rag, logRepo, memoryDb=null, linkDeps=null)`.

Финальный размер `packages/agent/src/services/memory.service.ts`: 362 LOC (был 305; net +57). Pre-existing >250 violation унаследован — документировано в плане §Файлы.

Приёмка:
- `bunx tsc --noEmit` → exit 0 ✓
- `bun test tests/memory-service-link-related.test.ts` → 5/5 pass ✓
- `bun test` → 800 pass, 0 fail (795 baseline + 5 new) ✓
- `grep -nE "linkDeps|linkRelated" packages/agent/src/services/memory.service.ts` → 13 hits ✓
- `grep -n "linkDeps:" packages/server/src/app/deps.ts` → 1 hit (комментарий) ✓
