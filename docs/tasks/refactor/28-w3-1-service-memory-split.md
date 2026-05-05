# 28-W3-1 — split `services/memory.service.ts` (380 → split-folder)

**Status:** OPEN. Master: [28-file-size-150-limit.md](28-file-size-150-limit.md) Wave 3.

**Order:** AFTER W3-2 merged.

## Цель

Разбить `packages/agent/src/services/memory.service.ts` (380 LOC) на split-folder. Public API = `MemoryService` class.

## Файлы

**Удалить**:
- `packages/agent/src/services/memory.service.ts`

**Создать**:
- `packages/agent/packages/agent/packages/agent/src/services/memory/index.ts` — `MemoryService` orchestrator (≤120 LOC).
- `packages/agent/src/services/memory/insert.ts` — `insertShared`, `insertContext`, `insertArchive` + embed-first transactional logic. Pure functions taking `{repo, rag}` deps.
- `packages/agent/src/services/memory/update.ts` — `updateShared`, `updateContext`, `updateArchive`.
- `packages/agent/src/services/memory/search.ts` — высокоуровневый `search()` объединяющий FTS + vec + rerank (если есть).
- `packages/agent/src/services/memory/link-related.ts` — `linkRelated`, `linkSemanticEdges` (если есть).
- `packages/agent/src/services/memory/dedupe.ts` — dedup-related logic (если есть в текущем файле).

**Trigger**: `scripts/check-file-size.ts` `"packages/agent/src/services/memory.service.ts": 381` → удалить.

## Изменение

1. `MemoryService` class в `index.ts` хранит deps (`repo`, `rag`) + thin делегации.
2. Submodules — pure functions taking deps explicitly. No closures over class state.
3. Никаких изменений семантики.
4. Все consumers (`hippocampus.ts`, `extractors.ts`, `ToolExecutor`, MCP `memory_*` tools) — через `~/services/memory`.

## Тесты

- `bun test tests/memory-service.test.ts` — green.
- `bun test tests/shared-embed-write.test.ts` — green.
- `bun test` — без regression (838/0).

## Приёмка

1. `bun run scripts/check-file-size.ts` — split ≤150, transitional удалена.
2. `bun run scripts/check-deep-imports.ts` — green.
3. `bunx tsc --noEmit` — clean.
4. `bun test tests/repo-rules.test.ts` — 5/5.
5. `bun test` — 838/0 baseline.

## Constraints

- Scope-lock: только файлы в §Файлы.
- Public API: `MemoryService` class methods unchanged.
- Service НИКОГДА не импортирует из `routes/*`, `mcp/transport.ts`, `web/*`.
- Service использует только `MemoryRepository` для DB-доступа (no raw SQL).
- Embed-first transactional shared writes preserved.
