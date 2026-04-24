# Задача 25b — Service слой: Memory (LAYER-2)

**Оценка:** 4 часа
**Зависимости:** 17, 22a
**Status:** DONE (PR 25b)

## Цель

Вынести бизнес-логику `routes/memory.ts` в `MemoryService`. Route остаётся тонким: TypeBox схема + HTTP envelope + вызов сервиса.

Параллельно это готовит почву под PR 27 (Repository слой): сервис — единственное место, где `MemoryDB` напрямую дёргается.

## Файлы

- [src/services/memory.service.ts](../../../src/services/memory.service.ts) — новый.
- [src/routes/memory.ts](../../../src/routes/memory.ts) — становится thin: TypeBox + delegation + paginate.
- [src/app/deps.ts](../../../src/app/deps.ts) — инстанцирует `MemoryService`.

## Изменение

### 1. `src/services/memory.service.ts`

Методы (строго по тому, что routes/memory.ts сегодня делает):

```
class MemoryService {
  constructor(
    private memory: MemoryDB,
    private rag: RAGPipeline,
  ) {}

  // Focus layer (L1, KV)
  listFocus(): FocusRow[];
  upsertFocus(id: string, value: string): void;
  deleteFocus(id: string): void;

  // Shared
  listShared(opts: { page, pageSize, q?, status? }): PaginatedResult<SharedRow>;
  insertShared(args: WriteSharedArgs): Promise<string>;   // возвращает id — embed+index inside (паттерн PR 24)
  patchShared(id: string, patch: Partial<SharedRow>): void;
  deleteShared(id: string): void;

  // Context (L2, per-session)
  listContext(opts): PaginatedResult<ContextRow>;
  // ...

  // Pending (from PR 22b)
  listPending(layer: "shared" | "context", opts): PaginatedResult;
  setStatus(layer: "shared" | "context", id: string, status: MemoryStatus): void;

  // Agent memory (read-only audit surface)
  listAgent(opts): PaginatedResult<AgentMemoryRow>;
  listLog(opts): PaginatedResult<LogRow>;   // read-only; без write
}
```

Методы с мутацией — через `updateRow(table, ALLOW, id, patch)` (guardrail §4). FTS-запросы — через существующие `MemoryDB.search*`, которые внутри `sanitizeFtsQuery`.

### 2. `src/routes/memory.ts`

Было ~300 LoC с inline-логикой. Становится ~100 LoC:

```
export function memoryRoute(memoryService: MemoryService) {
  return new Elysia({ prefix: "/v1/memory" })
    .get("/shared", async ({ query }) => paginate(query, memoryService.listShared(normalizeListOpts(query))))
    .post("/shared", { body: t.Object({...}) }, async ({ body }) => {
      const id = await memoryService.insertShared(body);
      return { id };
    })
    .patch("/shared/:id", { params: t.Object({id: t.String()}), body: t.Object({...}) }, async ({ params, body }) => {
      memoryService.patchShared(params.id, body);
      return { ok: true };
    })
    // ... etc
    ;
}
```

### 3. `deps.ts`

```
const memoryService = new MemoryService(memory, pipeline.rag);
return { ..., memoryService };
```

## Тесты

`tests/memory-service.test.ts`:

- Unit на stub `MemoryDB`: каждый метод сервиса вызывает правильный underlying метод с правильными аргументами.
- `insertShared` → embed + insert + upsertEmbedding (через stub rag).
- `setStatus(id, "active")` → вызов `updateRow(table, ALLOW, id, {status: "active"})`.

`tests/memory-routes-contract.test.ts`:

- `GET /v1/memory/shared` → 200, body shape `{ items, total }`.
- `POST /v1/memory/shared` без auth → 401 (middleware regression).
- С auth → 200 + body `{ id }`.

## Приёмка

- [ ] `bunx tsc --noEmit` = 0.
- [ ] `bun test tests/memory-service.test.ts tests/memory-routes-contract.test.ts` зелёные.
- [ ] `wc -l src/routes/memory.ts` <= 120 (было ~300).
- [ ] `grep -n 'memory.insert\|memory.db' src/routes/memory.ts` = 0.
- [ ] LAYER-2 вычеркнут в [docs/02-audit.md](../../02-audit.md).

## Deploy note

```bash
ssh root@109.120.187.244
cd /opt/subbrain
git pull
docker compose build && docker compose up -d
```
