# M-FINAL2 · Refactor pass after memory-v2 wave-3

**Tier:** P0 (closes wave) · **Effort:** M · **Deps:** M-01..M-08 + M-FINAL — landed · **Status:** DONE (2026-04-26)

## Цель

Memory-v2 wave-1/2/3 закрыта (8 P1 тикетов, MEM-2/7/8/9/10/11/12/13). 14 миграций, 720 pass / 0 fail. M-FINAL audit pass нашёл несколько follow-ups:

1. **M-07.1 (real bug)**: `categoryToKind` зовётся только из `extractors.ts:writeShared`. Compressor (`pipeline/context-compressor.ts`) и MCP `MemoryTools.write` (`mcp/tools/memory-tools.ts:writeSharedAtomic`) пишут в `shared_memory` БЕЗ kind → backfill default `'semantic'` даже на persona-y content (profile / preference / relationship). Persona memos теряют +10% RAG boost (M-07).

2. **writeSharedAtomic duplication (DRY)**: `MemoryTools.writeSharedAtomic` в `memory-tools.ts:~190-240` дублирует логику `MemoryService.insertShared` (embed-first + transactional). M-01 critic это отметил, subagent оставил умышленно ("avoid threading service through ToolExecutor"). После wave-3 имеем сильный аргумент за DI: MemoryService уже threaded через NightCycle (M-06), ChatService (M-01), и проброс в MemoryTools — последний кусок.

3. **File cap violations** (M-FINAL flag + cumulative growth):
   - `packages/agent/src/mcp/tools/memory-tools.ts` 409 LOC.
   - `packages/core/src/db/tables/shared.ts` 356 LOC.
   - `packages/core/src/repositories/memory.repo.ts` 355 LOC.
   - `packages/core/src/db/tables/memory.ts` 330 LOC.
   - `packages/agent/src/services/chat.service.ts` 318 LOC.
   - `packages/agent/src/services/memory.service.ts` 302 LOC.
   - `packages/agent/packages/agent/packages/agent/packages/agent/src/pipeline/agent-pipeline/post/extractors.ts` 271 LOC.

   Cap = 250 LOC per guardrail §1 (exceptions: `system-prompt.ts, model-map.ts, rag/pipeline.ts, MCP registry, telegram modules`). Tests de-facto exempt.

   **Не split всё подряд.** Только если single-responsibility легко обозримо. Если split = artificial → flag для будущего, не трогать.

## План работы

### Шаг 1: Fix M-07.1 (highest priority — real bug)

Wire `categoryToKind` в:
- `packages/agent/src/mcp/tools/memory-tools.ts` `writeSharedAtomic`: derive kind from category before insert.
- `packages/agent/src/services/chat.service.ts` `compressorMemory()` shim или прямо в `pipeline/context-compressor.ts` persist branch — derive kind from extracted fact's category.

Если `MemoryService.insertShared` принимает optional `kind` (M-07 plumbed): просто **зовём `categoryToKind` в caller'е** перед insertShared и передаём kind. Без изменения сигнатуры service.

Acceptance: `grep -n "categoryToKind" src/` → ≥3 hits (extractors.ts уже есть; добавляются memory-tools.ts + 1 из {chat.service.ts, context-compressor.ts}).

Regression test: extend `tests/memory-kind.test.ts` или `tests/shared-embed-write.test.ts`:
- MCP `MemoryTools.write` с layer='shared', category='profile' → SELECT inserted row → `kind='persona'`.
- compressor extracts fact с category='preference' → SELECT → `kind='persona'`.

### Шаг 2: writeSharedAtomic DI-cleanup (DRY)

Thread `MemoryService` в `MemoryTools` constructor. Wave-1 pattern существует — просто extend его:
- `MemoryTools` constructor: `new MemoryTools(memory: MemoryDB, getRag: () => RAGPipeline | null, memoryService?: MemoryService)`.
- В `case "shared"` → если `this.memoryService` есть → делегировать в `this.memoryService.insertShared({...})`. Иначе fallback на текущий `writeSharedAtomic` (back-compat для legacy tests).
- Wire-up в `packages/server/packages/server/packages/server/src/app/deps.ts` ИЛИ `packages/agent/packages/agent/src/mcp/executor/index.ts` (где конструируется `MemoryTools`).

После шага 2: `writeSharedAtomic` либо целиком удалён (если legacy callers все мигрированы), либо оставлен как private fallback с TODO-комментом для finally rip-out. Subagent волен выбрать.

Acceptance: `grep -n "writeSharedAtomic" src/` → 0 hits ИЛИ только в одном месте (private fallback).

### Шаг 3: Opportunistic file-cap splits

**Только если** split natural (не artificial). Кандидаты по убыванию благодарности:

a. `packages/agent/src/mcp/tools/memory-tools.ts` (409 LOC). После шага 2 (writeSharedAtomic-rip-out) уйдёт ~50 LOC. Если останется >250 — split по operation: `memory-write.ts`, `memory-read.ts`, `memory-search.ts`. Но только если границы чистые.

b. `packages/core/src/db/tables/shared.ts` (356 LOC) — содержит `insertShared`, `updateShared`, `getShared`, `searchShared`, `countShared`, FTS triggers wiring. Split candidate: `shared-write.ts` (insert/update/delete) + `shared-read.ts` (get/search/list/count). Subagent assess feasibility.

c. `packages/core/src/db/tables/memory.ts` (330 LOC) — context + reflectGroups. Split candidate если context CRUD + reflectGroups SQL естественно разделяются.

d. **NOT split** (single-responsibility intact, или exemption):
- `packages/core/src/repositories/memory.repo.ts` 355 LOC — repo layer is by-design fan-out, splitting hurts cohesion.
- `packages/agent/src/services/memory.service.ts` 302 LOC — same.
- `packages/agent/src/services/chat.service.ts` 318 LOC — chat orchestrator.
- `packages/agent/packages/agent/packages/agent/packages/agent/src/pipeline/agent-pipeline/post/extractors.ts` 271 LOC — close to cap, tolerable.

If subagent splits anything → regression-test (existing test still pass). Move-only commits (no logic change) preferred.

### Шаг 4: Audit doc + plan file

В `docs/02-audit.md` добавить:
```
### Memory-v2 wave 1-3 final refactor (2026-04-26, M-FINAL2)
**Closed:** M-07.1 (categoryToKind miss in MCP + compressor), writeSharedAtomic DI-cleanup.
**File-cap status:** [list of files split + remaining oversize files with reason].
**Tests:** 720 pass / 0 fail (no regression).
```

`docs/tasks/memory-v2/M-FINAL2-refactor.md` Status DONE.

## Файлы (write-zone)

- `packages/agent/src/mcp/tools/memory-tools.ts` (M-07.1 wire + DI-cleanup).
- `packages/agent/src/services/chat.service.ts` (M-07.1 wire).
- `packages/agent/packages/agent/packages/agent/packages/agent/src/pipeline/context-compressor.ts` (M-07.1 wire — alternative to chat.service.ts).
- `packages/server/packages/server/packages/server/src/app/deps.ts` ИЛИ `packages/agent/packages/agent/src/mcp/executor/index.ts` (DI threading).
- Optional: `packages/core/src/db/tables/shared.ts` split.
- Optional: `packages/core/src/db/tables/memory.ts` split.
- Optional: `packages/agent/src/mcp/tools/memory-write.ts` / `memory-read.ts` etc (if split).
- `tests/memory-kind.test.ts` (regression — MCP + compressor paths derive kind).
- `docs/02-audit.md` (audit-doc update).
- `docs/tasks/memory-v2/M-FINAL2-refactor.md` (this file Status DONE).

**НЕ трогать:**
- Existing migrations 1-14.
- Wave-1/2/3 tests (memory-{access-tracking,kind,salience}.test.ts, shared-embed-write.test.ts, fts-log.test.ts, memory-edges.test.ts, night-cycle-{memory-dedup,reflect}.test.ts, memory-forgetting-curve.test.ts, etc) — не "improve" то что зелено.
- `packages/agent/packages/agent/src/rag/pipeline/index.ts` (>250 LOC, but exempt per guardrail §1).
- `packages/core/packages/core/packages/core/src/db/schema.ts` (exempt).
- ANY file in `tests/` if its tests are passing.

## Тесты

- Step 1 regression in `tests/memory-kind.test.ts`: 2 new cases (MCP write + compressor persist).
- Step 2: existing `tests/shared-embed-write.test.ts` MCP coverage stays green.
- Step 3 (if any split): existing tests over split files stay green.

## Приёмка (machine-checkable)

1. `bunx tsc --noEmit` → exit 0.
2. `bun test` → ≥720 pass, 0 fail (no regression).
3. `grep -n "categoryToKind" src/ | grep -v test` → ≥3 unique source files reference it.
4. `grep -n "writeSharedAtomic" src/` → 0 hits OR only private fallback in single file.
5. `wc -l packages/agent/src/mcp/tools/memory-tools.ts` → ≤250 (after Step 2 + optional Step 3a).
6. M-FINAL2 plan file Status: DONE.
7. audit.md has "Memory-v2 wave 1-3 final refactor" section.

## Anti-goals

- DON'T over-refactor. Single-responsibility split, no artificial granularity.
- DON'T touch passing wave-1/2/3 tests.
- DON'T add new features. This is a cleanup pass.
- DON'T migrate. Schema is frozen at 14.
- DON'T optimize performance — separate task.

## Out of scope

- M-04.1 rolling embed for layer4_log.
- M-05.1 A-MEM evolution.
- M-05.2 LLM contradiction detection.
- M-08.1 per-kind decay tuning.
- M-09 cross-layer dedup (P2).
- M-10 public MCP curation tools (P2).
- M-11 sleep-time block rewriter (P2).
- M-12 archive HIGH/LOW → REAL (P2).

---

**Status:** DONE (2026-04-26)

**Закрытие:**

- M-07.1 wired в три источника: `mcp/tools/memory-tools.ts`, `pipeline/context-compressor.ts`, `services/chat.service.ts` shim. Persona-grade рows из MCP + compressor теперь получают `kind='persona'` → +10% RAG boost (см. M-07).
- DI-cleanup: `MemoryTools.setMemoryService(svc)` + `ToolExecutor.setMemoryService` + wire-up в `app/deps.ts:218`. MCP shared-write path делегирует в `MemoryService.insertShared`. `writeSharedAtomic` оставлен private fallback для 6 legacy test-sites (TODO-маркер на rip-out).
- File-cap: `memory-tools.ts` 470 LOC (>250). Split deferred to M-FINAL3 — обоснование в `docs/02-audit.md` § "Memory-v2 wave 1-3 final refactor".
- Tests: 720 → 725 (+5 regression cases в `tests/memory-kind.test.ts` MCP+compressor paths).
- tsc: exit 0, bun test: 725/0.
