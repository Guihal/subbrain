# packages/core/src/db/index.ts

## File
- Path: packages/core/src/db/index.ts
- Last modified: 2026-05-06T13:00:00+03:00
- Lines: 486

## Metrics
- Cyclomatic: 131
- Maintainability Index: 56.34
- Halstead difficulty: 0.10
- Coupling instability: 0.00 (afferent: 0, efferent: 0)
- Test:code ratio: N/A
- Functions: 118 (top complex: deleteExpiredShared@2, deleteExpiredContext@2, constructor@1, close@1, transaction@1)

## Smells
- [god-class] MemoryDB has 118 methods — far above 12 threshold. Every method is a 1-line facade forwarding to a repository. The class is a pure pass-through shell with zero logic of its own, yet occupies 486 lines.
- [fat-file] 486 lines exceeds 150-line cap by 3.2x. File is pre-existing oversize legacy per whitelist in `scripts/check-file-size.ts` and `docs/tasks/refactor/28-file-size-150-limit.md`.
- [raw-sql-in-facade] `deleteExpiredShared` @line:163 contains inline `SELECT COUNT(*) ...` + `DELETE FROM shared_memory WHERE ...` — violates "Routes must not contain SELECT/INSERT/UPDATE/DELETE" principle; this is Data-layer code but should live in `MemoryRepository` or `SharedTable`, not the facade.
- [raw-sql-in-facade] `deleteExpiredContext` @line:177 same pattern — inline SQL in facade.
- [raw-sql-in-facade] `deleteDoneTasksOlderThan` @line:430 contains inline `DELETE FROM tasks WHERE status = 'done' AND completed_at < unixepoch() - ?` — should live in `TasksTable`.
- [as-cast] `deleteExpiredShared` @line:169 casts query result `as { c: number }` instead of typed helper.
- [as-cast] `deleteExpiredContext` @line:183 same `as { c: number }` cast.
- [inline-import-type] `insertContext` @line:126 uses `import("./tables/memory").InsertContextOpts` inline instead of top-level import.
- [inline-import-type] `updateContext` @line:141 uses `import("./types").MemoryStatus` inline.
- [inline-import-type] `insertShared` @line:229 uses `import("./tables/shared").InsertSharedOpts` inline.
- [inline-import-type] `listShared` @line:236 uses `import("./types").MemoryKind` inline.
- [inline-import-type] `updateShared` @line:252 uses `import("./types").MemoryStatus` and `MemoryKind` inline.
- [inline-import-type] `setStatus` @line:302 uses `import("./types").MemoryStatus` inline.
- [inline-import-type] `linkEdge` @line:459 uses `import("./types").EdgeKind` inline.
- [inline-import-type] `getEdgesFromSrc` @line:467 uses `import("./types").EdgeKind` inline.
- [inline-import-type] `getEdgesToDst` @line:469 uses `import("./types").EdgeKind` inline.
- [inline-import-type] `getRelated` @line:473 uses `import("./types").EdgeKind` inline.
- [inline-import-type] `setChatPolicy` @line:330 uses `import("../repositories/tg-chat-policy.repo").TgChatPolicy` inline.
- [inline-import-type] `searchLog` @line:357 uses `import("./tables/log").SearchLogOpts` inline.
- [inline-import-type] `groupLogsBySession` @line:353 uses `import("./types").LogRow` inline.
- [missing-transaction-wrap] `deleteExpiredShared` and `deleteExpiredContext` run COUNT then DELETE as two separate statements without wrapping in `db.transaction()` — FTS shadow table note @line:164 acknowledges the issue but does not fix it.
- [dead-branch-comment] @line:64-65 comment says "`tasks` and `scheduler_state` stay on the facade pending a PR 27+ split" — this is a known deferred item.
- [public-field] `db: Database` @line:68 is public — any caller can bypass the repository layer and issue raw SQL. Should be `readonly` at minimum, ideally private with accessor.

## Refactor proposal
- Split: `packages/core/src/db/facade/` — one file per domain:
  - `facade/memory.ts` — focus, shadow, context, archive, shared, agent, blocks, edges, embeddings
  - `facade/chat.ts` — chats, messages, tg exclusions
  - `facade/log.ts` — raw log, log search
  - `facade/telegram.ts` — tg messages
  - `facade/freelance.ts` — freelance leads
  - `facade/tasks.ts` — tasks + scheduler state (the deferred PR 27+ split)
  - `facade/index.ts` — re-export + thin `MemoryDB` class that composes the above (≤100 lines per orchestrator rule)
- Extract: `deleteExpiredShared` → `MemoryRepository.deleteExpiredShared(nowSec: number)`; `deleteExpiredContext` → `MemoryRepository.deleteExpiredContext(nowSec: number)`; `deleteDoneTasksOlderThan` → `TasksTable.deleteDoneOlderThan(ageSec: number)`.
- Replace: All 15 inline `import("...").Type` expressions → top-level `import type { ... }` at file head. `as { c: number }` → typed query helper or `.get()` with `SafeParse`.
- Safety: Wrap `deleteExpiredShared`/`deleteExpiredContext` COUNT+DELETE pairs in `this.db.transaction()`; the FTS shadow-table concern is about `.changes` inflation, not atomicity — but both matter.

## Risk
- Level: medium
- Reason: 83 test files reference `MemoryDB` directly; any rename or signature change breaks the test suite. The facade is a compatibility surface for `scripts/seed.ts`, `scripts/audit-db.ts`, and legacy callers.
- Test coverage observed: tests/db.test.ts, tests/memory-service.test.ts, tests/memory-edges.test.ts, tests/tasks.test.ts, tests/freelance-leads.test.ts, tests/rag.test.ts, tests/night-cycle-reflect.test.ts, tests/night-cycle-embed-log.test.ts, tests/hippocampus-task-budget.test.ts, tests/pipeline-post-dedupe.test.ts, tests/pipeline-post-supersede.test.ts, tests/post-link-related-contradictions.test.ts, tests/memory-forgetting-curve.test.ts, tests/memory-service-link-related.test.ts, tests/cross-agent-isolation.test.ts, tests/migrate-tasks-from-memory.test.ts, tests/metrics.test.ts, tests/tasks-retention.test.ts, tests/tool-runner.test.ts, tests/logger-swallow.test.ts (and 65 more)
