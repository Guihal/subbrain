# Phase 3 — Memory-v2 finalization (consolidated Kimi packets)

**Spec ref:** `docs/specs/subbrain-main.md` § Phase 3 (lines 443–473).
**Worker model:** Kimi K2.6 via `kimi-claude` (preserves thinking field).
**Cluster scope:** consolidates 4 inputs into 9 sequenced execution packets.

> **Schema-tier escalation (P3-2 + P3-5):** these two packets are
> `risk_tier: "schema"`. They are **STRONG-MODEL ONLY**. Kimi must
> output `FAIL: requires_strong_model` instead of attempting either
> packet — pre-baked in their `escalation_triggers` and reflected by
> the explicit annotation block in each. Operator escalates to Opus.

## Goal of Phase 3

Finalize Memory-v2: bi-temporal facts + retrieval filters, edge-walk boost in
RAG, explicit editable memory blocks, sleep-time role promotion, hippocampus
write-cap (PR-43) + persona pass (PR-44), and curation-test expansion.

All landed Memory-v2 work (reflect M-06, forgetting curve M-08, cross-layer
dedup M-09, curation tools M-10, memory_edges M-05, salience M-03,
access-tracking M-02, kind M-07, archive-confidence M-12) is **dependency**
and must not be re-implemented. Any packet that touches that surface is
out-of-scope.

## Source inputs (read-only)

1. `docs/tasks/agent-teams/02-memory-bi-temporal.md` — this file (foundation;
   replaced by current consolidated form).
2. `docs/tasks/memory-v2/M-12-archive-confidence-real.md` — archive
   `confidence` HIGH/LOW → REAL (Status: **DONE** in source; landed in
   Migration 15 at `packages/core/src/db/schema.ts:820-862`). Phase 3 keeps a verification
   packet only.
3. `docs/tasks/refactor/43-prd-hippocampus-rewrite.md` — PR-D hippocampus
   rewrite + write-cap (includes `packages/core/src/lib/metrics.ts` counter scope).
4. `docs/tasks/refactor/44-pre-character.md` — PR-E persona pass over
   teamlead synthesis + hippocampus character (depends on PR-D landed).

## Hard non-goals (apply to every packet below)

1. No external memory framework (Mem0, Letta, Zep, mem-zero).
2. No separate graph DB (Neo4j, Kuzu, Memgraph).
3. Do NOT re-implement reflect / forgetting curve / cross-layer dedup
   / curation tools — those are M-06/M-08/M-09/M-10 and already landed.
4. Do NOT change the public MCP `memory_*` tool surface (`memory_search`,
   `memory_read`, `memory_write`, `memory_delete`).
5. Do NOT change embed model / rerank model selection — `EMBED_MODEL` /
   `RERANK_MODEL` in `packages/core/src/lib/model-map.ts` are fixed.
6. Do NOT change `memory_edges` schema (M-05 landed).
7. Do NOT modify Telegram bot, frontend (`web/app/`), or autonomous loop.
8. Do NOT touch `archive` confidence column — M-12 already landed.

## Ordering (strict serial; merge dependencies are HARD)

`P3-2` and `P3-5` both author a SQLite migration on top of the same file
(`packages/core/src/db/schema.ts`). They CANNOT run in parallel — both would claim version
17 and one would silently overwrite the other. P3-2 lands Migration 17 first;
P3-5 only starts after P3-2 is **merged** and writes Migration 18.

```
P3-1 (M-12 verify, ordinary)
   └─> P3-2 (mig 17, schema, STRONG-MODEL ONLY)              [merge gate]
         ├─> P3-3 (active filter, public-api)                 \
         │     └─> P3-4 (edge-walk boost, ordinary)            } parallel after P3-2 merged
         └─> P3-5 (mig 18, schema, STRONG-MODEL ONLY)         /  [merge gate]
               └─> P3-6 (sleep role, public-api)
                     └─> P3-7 (PR-D write-cap, public-api)
                           └─> P3-8 (PR-E persona, ordinary)
                                 └─> P3-9 (curation tests, ordinary)
```

Allowed parallel waves:
- Wave A (post-P3-1 merged, post-P3-2 merged): **{P3-3, P3-4}** parallel.
- Wave B (post-P3-2 merged): **{P3-5}** alone (schema, single-writer).
- Wave C (post-P3-5 merged): **{P3-6}** alone, then **{P3-7}**, **{P3-8}**,
  **{P3-9}** strictly serial.

Two schema packets (P3-2, P3-5) NEVER run concurrently. Operator is
responsible for the merge gate; Kimi packets do not include any "wait for
PR" logic.

## Open design choices (resolved before Kimi runs)

1. **P3-2 storage shape:** additive nullable columns on `shared_memory`
   AND `layer2_context` (per source draft) — DECIDED HERE in favor of
   columns. Validity table option flagged in `escalation_triggers` if
   row-count grows unbounded; out-of-scope for first pass.
2. **P3-3 layer scope:** filter is applied to BOTH `shared_memory` and
   `layer2_context` retrieval (FTS + vec + helper paths). Shared-memory
   retrieval is currently in `packages/core/src/db/tables/shared/search-vec.ts`; context
   retrieval in `packages/core/src/db/tables/memory/*` and `packages/agent/src/rag/pipeline/{fts,vec}.ts`.
3. **P3-4 boost cap:** non-stacking semantics. Final boost on a row is
   `max(personaBoost, salienceBoost, edgeWalkBoost)`, NOT product. This
   prevents the 1.21× combined ceiling concern. Glossary + acceptance grep
   for `Math.max` enforce.
4. **P3-5 memory blocks shape:** new `memory_blocks` table — DECIDED
   HERE. Reuse of `shared_memory` rejected because blocks need explicit
   lifecycle (user-editable, version-tagged, distinct from extracted
   facts). Escalation trigger included if spec ambiguity surfaces.
5. **P3-6 NIGHT_CYCLE_MODEL fallback:** must be centralised. Five sites
   currently duplicate `process.env.NIGHT_CYCLE_MODEL || "memory"`:
   `packages/agent/src/pipeline/night-cycle/steps/shared.ts:8`,
   `packages/agent/src/pipeline/night-cycle/prune/shared.ts:7`,
   `packages/agent/src/pipeline/night-cycle/prune/context.ts:8`,
   `packages/agent/src/pipeline/night-cycle/prune/focus.ts:7`,
   `packages/agent/src/pipeline/night-cycle/prune/tasks-classify.ts:102`. P3-6 introduces
   `packages/agent/src/pipeline/night-cycle/model.ts` (single export `resolveNightModel()`)
   and rewires every callsite. Acceptance greps the five files for zero
   remaining `NIGHT_CYCLE_MODEL` literals.

## Path-correction note (was wrong in the previous draft)

Earlier drafts referenced `packages/agent/src/rag/pipeline/index.ts`. That file does NOT exist.
Real layout is split: `packages/agent/src/rag/pipeline/index.ts` plus
`{boosts,embed,fts,vec,rerank,rrf}.ts` siblings. All packets below reference
the split paths.

---

## Packet P3-1 — M-12 verify-only (archive confidence already REAL)

```json
{
  "task_id": "P3-1",
  "goal": "Verify Migration 15 landed and `layer3_archive.confidence` is REAL with no string-literal callers remaining; abort with FAIL if drift detected.",
  "non_goals": [
    "Do not modify `packages/core/src/db/schema.ts` Migration 15 SQL.",
    "Do not change `layer3_archive.confidence` type or backfill values.",
    "Do not edit `tests/memory-archive-confidence.test.ts`.",
    "Do not run `bun run scripts/seed.ts` or any data-mutation script.",
    "Do not touch `shared_memory` / `layer2_context` confidence columns."
  ],
  "allowed_write_paths": [
    "docs/tasks/memory-v2/M-12-archive-confidence-real.md"
  ],
  "read_context": [
    "packages/core/src/db/schema.ts:800-865",
    "docs/tasks/memory-v2/M-12-archive-confidence-real.md",
    "tests/memory-archive-confidence.test.ts"
  ],
  "risk_tier": "ordinary",
  "acceptance": [
    "bunx tsc --noEmit",
    "bun test tests/memory-archive-confidence.test.ts",
    "test \"$(grep -c 'PRAGMA user_version = 15' packages/core/src/db/schema.ts)\" -ge 1",
    "test \"$(grep -rn \"'HIGH'\\|'LOW'\" src/ --include='*.ts' | grep archive | grep -v test | grep -v '//' | grep -v schema.ts | wc -l)\" -eq 0",
    "grep -q '^**Status:** DONE' docs/tasks/memory-v2/M-12-archive-confidence-real.md || sed -i 's/^**Status:** OPEN/**Status:** DONE/' docs/tasks/memory-v2/M-12-archive-confidence-real.md"
  ],
  "diff_budget_loc": 5,
  "file_count_max": 1,
  "rollback": "Revert any sed edit on M-12 doc; verification packet has no schema impact.",
  "escalation_triggers": [
    "Migration 15 missing from packages/core/src/db/schema.ts",
    "grep finds 'HIGH'/'LOW' archive callers outside schema migration backfill",
    "tests/memory-archive-confidence.test.ts fails",
    "user_version reads <15 on existing dev DB",
    "M-12 source doc disagrees with landed schema"
  ],
  "glossary": {
    "Migration 15": "packages/core/src/db/schema.ts block guarded by `if (version < 15)` that rebuilds layer3_archive with REAL confidence",
    "user_version": "SQLite PRAGMA tracking applied migration index"
  }
}
```

---

## Packet P3-2 — Bi-temporal columns on shared_memory + layer2_context (Migration 17)

> **STRONG-MODEL ONLY. Kimi: emit `FAIL: requires_strong_model` and stop.**
> Reason: schema-tier (`risk_tier: "schema"`), single-writer migration on
> `packages/core/src/db/schema.ts` (currently `user_version=16` at line 879). Migration
> mistakes here are not safely revertible on prod. Operator escalates to
> Opus / Codex critic. **Merge gate:** P3-5 cannot start until this packet
> is merged.

```json
{
  "task_id": "P3-2",
  "requires_strong_model": true,
  "kimi_action_if_invoked": "FAIL: requires_strong_model",
  "goal": "Add nullable `valid_from`, `valid_to`, `observed_at` columns to `shared_memory` AND `layer2_context` via Migration 17 with idempotent guard. Wire shared-memory CRUD + context CRUD helpers to round-trip the new columns.",
  "non_goals": [
    "Do not add columns to `layer3_archive` in this packet.",
    "Do not add columns to `memory_edges`.",
    "Do not change embedding dimensions or FTS schema.",
    "Do not change retrieval queries (P3-3 handles that).",
    "Do not change any `memory_*` MCP tool signatures.",
    "Do not introduce a separate validity table.",
    "Do not start P3-5 (Migration 18) — that is gated on this packet merging."
  ],
  "allowed_write_paths": [
    "packages/core/src/db/schema.ts",
    "packages/core/src/db/types.ts",
    "packages/core/src/db/tables/memory/helpers.ts",
    "packages/core/src/db/tables/memory/context.ts",
    "packages/core/src/db/tables/shared/helpers.ts",
    "packages/core/src/db/tables/shared/index.ts",
    "packages/core/src/repositories/memory/index.ts",
    "tests/memory-bi-temporal-schema.test.ts"
  ],
  "read_context": [
    "packages/core/src/db/schema.ts:860-887",
    "packages/core/src/db/tables/memory/context.ts",
    "packages/core/src/db/tables/memory/helpers.ts",
    "packages/core/src/db/tables/shared/helpers.ts",
    "packages/core/src/db/tables/shared/index.ts",
    "packages/core/src/db/tables/shared/search-vec.ts",
    "packages/core/src/repositories/memory/index.ts",
    "packages/core/src/db/types.ts"
  ],
  "risk_tier": "schema",
  "acceptance": [
    "bunx tsc --noEmit",
    "bun test tests/memory-bi-temporal-schema.test.ts",
    "bun test 2>&1 | tail -3 | grep -q '0 fail'",
    "bun -e 'import {MemoryDB} from \"./src/db\"; const db=new MemoryDB(\":memory:\"); const v=db.db.query(\"PRAGMA user_version\").get(); if (v.user_version!==17) process.exit(1)'",
    "test \"$(sqlite3 data/test.db \"PRAGMA table_info(shared_memory)\" | grep -cE 'valid_from|valid_to|observed_at')\" -eq 3",
    "test \"$(sqlite3 data/test.db \"PRAGMA table_info(layer2_context)\" | grep -cE 'valid_from|valid_to|observed_at')\" -eq 3",
    "bun run scripts/check-file-size.ts",
    "bun run scripts/check-deep-imports.ts"
  ],
  "diff_budget_loc": 320,
  "file_count_max": 8,
  "rollback": "Drop the `if (version < 17)` block in packages/core/src/db/schema.ts; `valid_from`/`valid_to`/`observed_at` are additive nullable columns so no data loss. Revert helper additions in shared/memory tables.",
  "escalation_triggers": [
    "user_version read != 16 before migration runs (means another migration landed; coordinate version number)",
    "ALTER TABLE ADD COLUMN fails because of existing column collision",
    "Spec contradicts code (column choice vs separate validity table) — STOP and ask before writing",
    "Diff exceeds 320 LOC",
    "Existing tests fail because of new NOT NULL default mismatch",
    "Kimi invoked — emit FAIL: requires_strong_model"
  ],
  "glossary": {
    "valid_from": "INTEGER unix-seconds; when the fact became true in user world; nullable",
    "valid_to": "INTEGER unix-seconds; when fact ceased; null = still current",
    "observed_at": "INTEGER unix-seconds; when Subbrain learned the fact; defaults to (unixepoch()) on insert",
    "Migration 17": "Next sequential migration after 16 (layer1_focus_shadow); guarded by `if (version < 17)`",
    "shared CRUD path": "packages/core/src/db/tables/shared/helpers.ts (SHARED_UPDATABLE allow-list) + shared/index.ts (insertShared/updateShared) + repositories/memory/index.ts facade — bi-temporal columns must round-trip through ALL three"
  }
}
```

---

## Packet P3-3 — Bi-temporal active filter in retrieval

```json
{
  "task_id": "P3-3",
  "goal": "Apply a single parenthesized temporal predicate beside `status='active'` for both shared_memory and layer2_context retrieval (FTS, vec, helper paths). The predicate is wrapped to avoid AND/OR precedence leaks.",
  "non_goals": [
    "Do not modify the active-status filter (status='active') — this packet adds a temporal filter beside it.",
    "Do not change `EMBED_MODEL` / `RERANK_MODEL`.",
    "Do not change RRF weights.",
    "Do not modify `getShared` / `getContext` row-fetch helpers (they should still return historical rows for admin views).",
    "Do not touch `layer3_archive` retrieval path.",
    "Do not change MCP `memory_search` tool signature."
  ],
  "allowed_write_paths": [
    "packages/core/src/db/tables/memory/helpers.ts",
    "packages/core/src/db/tables/memory/search.ts",
    "packages/core/src/db/tables/shared/helpers.ts",
    "packages/core/src/db/tables/shared/search-vec.ts",
    "packages/agent/src/rag/pipeline/fts.ts",
    "packages/agent/src/rag/pipeline/vec.ts",
    "tests/rag-bi-temporal-filter.test.ts"
  ],
  "read_context": [
    "packages/core/src/db/tables/memory/helpers.ts",
    "packages/core/src/db/tables/memory/search.ts",
    "packages/core/src/db/tables/shared/helpers.ts",
    "packages/core/src/db/tables/shared/search-vec.ts",
    "packages/agent/src/rag/pipeline/fts.ts",
    "packages/agent/src/rag/pipeline/vec.ts",
    "packages/agent/src/rag/pipeline/index.ts"
  ],
  "risk_tier": "public-api",
  "acceptance": [
    "bunx tsc --noEmit",
    "bun test tests/rag-bi-temporal-filter.test.ts",
    "bun test 2>&1 | tail -3 | grep -q '0 fail'",
    "grep -nE 'AND \\(valid_from IS NULL OR valid_from <= unixepoch\\(\\)\\) AND \\(valid_to IS NULL OR valid_to > unixepoch\\(\\)\\)' packages/core/src/db/tables/memory/helpers.ts | wc -l | grep -qE '^[1-9]'",
    "grep -nE 'AND \\(valid_from IS NULL OR valid_from <= unixepoch\\(\\)\\) AND \\(valid_to IS NULL OR valid_to > unixepoch\\(\\)\\)' packages/core/src/db/tables/shared/helpers.ts | wc -l | grep -qE '^[1-9]'",
    "grep -nE 'valid_to IS NULL OR valid_to' packages/agent/src/rag/pipeline/fts.ts | wc -l | grep -qE '^[1-9]'",
    "grep -nE 'valid_to IS NULL OR valid_to' packages/agent/src/rag/pipeline/vec.ts | wc -l | grep -qE '^[1-9]'",
    "bun run scripts/check-file-size.ts",
    "bun run scripts/check-deep-imports.ts"
  ],
  "diff_budget_loc": 260,
  "file_count_max": 7,
  "rollback": "Revert the WHERE-clause additions in helpers.ts (memory + shared) / search.ts / search-vec.ts / fts.ts / vec.ts; columns remain unused but harmless.",
  "escalation_triggers": [
    "P3-2 not merged (columns missing) — STOP, schema drift",
    "Test asserts retrieval finds expired rows (filter is wrong direction)",
    "FTS5 MATCH syntax breaks because temporal filter merged into MATCH expression",
    "Diff exceeds 260 LOC",
    "Spec contradiction: admin endpoint suddenly hides historical rows",
    "Operator-precedence test (mixed status='active' OR-chains) fails — predicate must be wrapped in single outer parens"
  ],
  "glossary": {
    "active filter": "exact SQL fragment ` AND (valid_from IS NULL OR valid_from <= unixepoch()) AND (valid_to IS NULL OR valid_to > unixepoch())` appended after status filter; both sub-clauses wrapped to lock precedence",
    "buildActiveFilter": "existing helper duplicated in `packages/core/src/db/tables/{memory,shared}/helpers.ts` that composes status='active' + supersedes/expires clauses; extend BOTH copies with the temporal predicate and add a unit test that mixes status with temporal filter to assert no AND/OR precedence leak",
    "predicate wrapping rule": "ban concatenation like `AND a IS NULL OR a <= now`; require `AND (a IS NULL OR a <= now)` (each disjunction wrapped) so outer AND-chain stays correct under SQL precedence"
  }
}
```

---

## Packet P3-4 — Edge-walk boost in RAG pipeline (non-stacking)

```json
{
  "task_id": "P3-4",
  "goal": "Add `applyEdgeWalkBoost` in `packages/agent/src/rag/pipeline/boosts.ts`. It walks 1-hop neighbours via `MemoryDB.getRelated(id, layer, 1)` (layer-aware API; respects `src_layer`/`dst_layer` columns from M-05) and bumps reachable result rows by 1.08×. Final boost is composed NON-STACKING with persona/salience: `score *= max(personaFactor, salienceFactor, edgeFactor)` rather than the product.",
  "non_goals": [
    "Do not change `memory_edges` schema.",
    "Do not implement n-hop walk (1-hop only in this packet).",
    "Do not run a graph DB.",
    "Do not change persona or salience boost factors.",
    "Do not touch FTS / vec / RRF stages.",
    "Do not change `MAX_HIPPO_STEPS` or any hippocampus surface.",
    "Do not stack boost factors multiplicatively — combined ceiling stays at 1.10× (max of three signals)."
  ],
  "allowed_write_paths": [
    "packages/agent/src/rag/pipeline/boosts.ts",
    "packages/agent/src/rag/pipeline/index.ts",
    "tests/rag-edge-walk-boost.test.ts"
  ],
  "read_context": [
    "packages/agent/src/rag/pipeline/boosts.ts",
    "packages/agent/src/rag/pipeline/index.ts",
    "packages/core/src/db/tables/edges.ts",
    "packages/core/src/db/index.ts:425-450",
    "packages/core/src/db/tables/memory/index.ts"
  ],
  "risk_tier": "ordinary",
  "acceptance": [
    "bunx tsc --noEmit",
    "bun test tests/rag-edge-walk-boost.test.ts",
    "bun test 2>&1 | tail -3 | grep -q '0 fail'",
    "grep -nE 'applyEdgeWalkBoost|EDGE_WALK_BOOST' packages/agent/src/rag/pipeline/boosts.ts | wc -l | grep -qE '^[2-9]'",
    "grep -nE 'applyEdgeWalkBoost' packages/agent/src/rag/pipeline/index.ts | wc -l | grep -qE '^[1-9]'",
    "grep -nE 'getRelated\\(' packages/agent/src/rag/pipeline/boosts.ts | wc -l | grep -qE '^[1-9]'",
    "grep -nE 'Math\\.max\\(' packages/agent/src/rag/pipeline/boosts.ts | wc -l | grep -qE '^[1-9]'",
    "bun run scripts/check-file-size.ts",
    "bun run scripts/check-deep-imports.ts"
  ],
  "diff_budget_loc": 220,
  "file_count_max": 3,
  "rollback": "Remove `applyEdgeWalkBoost` import + call from `packages/agent/src/rag/pipeline/index.ts`; helper becomes dead code.",
  "escalation_triggers": [
    "memory_edges table missing (M-05 not landed)",
    "Edge-walk join causes >100ms RAG latency on test fixture (≥1k edges)",
    "Diff exceeds 220 LOC",
    "Test fails to assert non-stacking semantics (combined factor > 1.10×) — switch implementation, not assertion"
  ],
  "glossary": {
    "edge-walk boost": "1-hop neighbour multiplier 1.08; combined with persona/salience via Math.max, NOT product — combined ceiling stays at 1.10×",
    "memory_edges": "table from M-05 with (src_id, src_layer, dst_id, dst_layer, kind, weight) — DO NOT modify",
    "layer-qualified API": "MemoryDB.getRelated(id, layer, depth=1) returns {id, layer, kind, weight}[] — boost must use this layer-aware return, not raw id-only",
    "non-stacking semantics": "`finalScore = baseScore * Math.max(personaFactor, salienceFactor, edgeFactor)` — product was rejected because 1.10 × 1.10 × 1.08 = 1.31× drowns rerank cosine"
  }
}
```

---

## Packet P3-5 — `memory_blocks` table (Migration 18) — explicit editable units

> **STRONG-MODEL ONLY. Kimi: emit `FAIL: requires_strong_model` and stop.**
> Reason: schema-tier (`risk_tier: "schema"`), Migration 18 author. **Hard
> merge dependency:** P3-2 (Migration 17) must be merged FIRST; running this
> packet against an unmerged P3-2 produces a version-17/18 collision in
> `packages/core/src/db/schema.ts`. Operator gate-keeps the merge order; Kimi is told to
> abort outright.

```json
{
  "task_id": "P3-5",
  "requires_strong_model": true,
  "kimi_action_if_invoked": "FAIL: requires_strong_model",
  "merge_dependency": "P3-2 must be MERGED to main before this packet starts. Running before P3-2 merges will collide on user_version.",
  "goal": "Add `memory_blocks` table (id TEXT PK, owner_role TEXT, label TEXT, body TEXT NOT NULL, created_at INTEGER, updated_at INTEGER, version INTEGER NOT NULL DEFAULT 1, UNIQUE(owner_role, label)) via Migration 18 with idempotent guard; expose CRUD helpers in new `packages/core/src/db/tables/memory/blocks.ts`.",
  "non_goals": [
    "Do not extend `shared_memory` to absorb blocks (explicit denial of reuse).",
    "Do not add blocks to MCP `memory_*` tool surface (out-of-scope; Phase 3 only persists schema + helpers).",
    "Do not change `system-prompt.ts` to read blocks (Phase 3 schema-only).",
    "Do not implement block-versioning history table (single-row mutate via `version++`).",
    "Do not seed default blocks in this packet.",
    "Do not change FTS or vec indexes.",
    "Do not start before P3-2 is merged — this packet writes Migration 18 against user_version=17."
  ],
  "allowed_write_paths": [
    "packages/core/src/db/schema.ts",
    "packages/core/src/db/types.ts",
    "packages/core/src/db/tables/memory/blocks.ts",
    "packages/core/src/db/tables/memory/index.ts",
    "tests/memory-blocks.test.ts"
  ],
  "read_context": [
    "packages/core/src/db/schema.ts:860-887",
    "packages/core/src/db/tables/memory/index.ts",
    "packages/core/src/db/tables/memory/helpers.ts",
    "packages/core/src/db/types.ts"
  ],
  "risk_tier": "schema",
  "acceptance": [
    "bunx tsc --noEmit",
    "bun test tests/memory-blocks.test.ts",
    "bun test 2>&1 | tail -3 | grep -q '0 fail'",
    "bun -e 'import {MemoryDB} from \"./src/db\"; const db=new MemoryDB(\":memory:\"); const v=db.db.query(\"PRAGMA user_version\").get(); if (v.user_version!==18) process.exit(1)'",
    "test \"$(sqlite3 data/test.db \"SELECT name FROM sqlite_master WHERE type='table' AND name='memory_blocks'\")\" = 'memory_blocks'",
    "bun run scripts/check-file-size.ts",
    "bun run scripts/check-deep-imports.ts"
  ],
  "diff_budget_loc": 280,
  "file_count_max": 5,
  "rollback": "DROP TABLE memory_blocks; revert schema.ts version-18 block. Additive table — no data loss elsewhere.",
  "escalation_triggers": [
    "user_version != 17 at start (P3-2 not merged) — abort, do not write Migration 18",
    "Spec ambiguity on block storage: if user picks 'extend shared_memory with kind=block' instead of new table, STOP — design choice has cascading effects",
    "Spec ambiguity on block label uniqueness: locked HERE to per-owner via `UNIQUE(owner_role, label)` — escalate if spec disagrees",
    "Diff exceeds 280 LOC",
    "Block schema needs FK to `agent_id` — out-of-scope until owner_role pattern proves insufficient",
    "Kimi invoked — emit FAIL: requires_strong_model"
  ],
  "glossary": {
    "memory_blocks": "Editable named text fragments scoped per role (e.g. teamlead.persona, hippocampus.character)",
    "owner_role": "TEXT virtual-role id from packages/core/src/lib/model-map.ts (teamlead|coder|critic|memory|...)",
    "version": "Monotonic counter on update; admin UI uses to detect concurrent edits (Phase 3 schema only, no enforcement)",
    "label uniqueness": "per-owner — `UNIQUE(owner_role, label)`; same label re-usable across roles"
  }
}
```

---

## Packet P3-6 — Sleep-time role promotion + NIGHT_CYCLE_MODEL consolidation

```json
{
  "task_id": "P3-6",
  "goal": "Add `sleep` virtual role in `packages/core/src/lib/model-map.ts` mapping to `deepseek-ai/deepseek-v4-flash` (NIM, fallback `MiniMax-M2.7`). Centralise the `NIGHT_CYCLE_MODEL` env-fallback resolver in a new `packages/agent/src/pipeline/night-cycle/model.ts` (`resolveNightModel()` returns `process.env.NIGHT_CYCLE_MODEL || \"sleep\"`) and rewire ALL FIVE duplicate sites to use it.",
  "non_goals": [
    "Do not change `memory` role (post-extractor remains independent).",
    "Do not rename existing roles (`teamlead`/`coder`/`critic`/`flash`/`chaos`/`generalist`/`memory`).",
    "Do not change embed/rerank model constants.",
    "Do not implement new schedule logic — only role-resolution.",
    "Do not edit night-cycle step internals (compress/translate/PII-scrub bodies); only the env-fallback wiring."
  ],
  "allowed_write_paths": [
    "packages/core/src/lib/model-map.ts",
    "packages/agent/src/pipeline/night-cycle/model.ts",
    "packages/agent/src/pipeline/night-cycle/steps/shared.ts",
    "packages/agent/src/pipeline/night-cycle/prune/shared.ts",
    "packages/agent/src/pipeline/night-cycle/prune/context.ts",
    "packages/agent/src/pipeline/night-cycle/prune/focus.ts",
    "packages/agent/src/pipeline/night-cycle/prune/tasks-classify.ts",
    "tests/model-map-sleep-role.test.ts"
  ],
  "read_context": [
    "packages/core/src/lib/model-map.ts",
    "packages/agent/src/pipeline/night-cycle/index.ts",
    "packages/agent/src/pipeline/night-cycle/steps/shared.ts",
    "packages/agent/src/pipeline/night-cycle/prune/shared.ts",
    "packages/agent/src/pipeline/night-cycle/prune/context.ts",
    "packages/agent/src/pipeline/night-cycle/prune/focus.ts",
    "packages/agent/src/pipeline/night-cycle/prune/tasks-classify.ts",
    "CLAUDE.md"
  ],
  "risk_tier": "public-api",
  "acceptance": [
    "bunx tsc --noEmit",
    "bun test tests/model-map-sleep-role.test.ts",
    "bun test 2>&1 | tail -3 | grep -q '0 fail'",
    "grep -nE '^\\s*sleep:\\s*\\{' packages/core/src/lib/model-map.ts | wc -l | grep -qE '^[1-9]'",
    "grep -nE 'export function resolveNightModel' packages/agent/src/pipeline/night-cycle/model.ts | wc -l | grep -qE '^[1-9]'",
    "test \"$(grep -rnE 'process\\.env\\.NIGHT_CYCLE_MODEL' packages/agent/src/pipeline/night-cycle/ | wc -l)\" -eq 1",
    "test \"$(grep -rnE 'NIGHT_CYCLE_MODEL\\s*\\|\\|' packages/agent/src/pipeline/night-cycle/ | wc -l)\" -eq 1",
    "grep -rnE 'resolveNightModel\\(' packages/agent/src/pipeline/night-cycle/ | wc -l | grep -qE '^[5-9]|[1-9][0-9]'",
    "bun run scripts/check-file-size.ts",
    "bun run scripts/check-deep-imports.ts",
    "bun run scripts/check-model-ids.ts"
  ],
  "diff_budget_loc": 220,
  "file_count_max": 8,
  "rollback": "Remove `sleep` entry from MODEL_MAP, drop `model.ts`, restore the five inline `process.env.NIGHT_CYCLE_MODEL || \"memory\"` literals.",
  "escalation_triggers": [
    "Adding role breaks `/v1/models` route generation",
    "Existing night-cycle tests rely on env reading raw model id directly (not via resolver)",
    "MODEL_MAP entry collides with existing role name",
    "Diff exceeds 220 LOC",
    "Any night-cycle file still contains a `NIGHT_CYCLE_MODEL` literal after refactor — re-do, do NOT silence the grep"
  ],
  "glossary": {
    "sleep role": "Virtual role for night-cycle steps (PII-scrub / translate / compress / verify / dedup); replaces hardcoded NIGHT_CYCLE_MODEL env default `\"memory\"`",
    "model-map.ts": "Single source of truth for virtual-role -> real model id (CLAUDE.md guardrail #11)",
    "five duplicate sites": "packages/agent/src/pipeline/night-cycle/steps/shared.ts:8, prune/shared.ts:7, prune/context.ts:8, prune/focus.ts:7, prune/tasks-classify.ts:102 — all collapse to a single `resolveNightModel()` call",
    "resolver semantics": "process.env.NIGHT_CYCLE_MODEL || \"sleep\" (was \"memory\"); the only place the literal `NIGHT_CYCLE_MODEL` may appear is the resolver itself"
  }
}
```

---

## Packet P3-7 — PR-D hippocampus write-cap (focused writes)

```json
{
  "task_id": "P3-7",
  "goal": "Implement PR-D from `docs/tasks/refactor/43-prd-hippocampus-rewrite.md`: rewrite `getExtractorPrompt` body (text only), add `MAX_WRITES_PER_EXCHANGE=3` cap + telemetry counter (via `packages/core/src/lib/metrics.ts` — file already exists per source PRD §3) + `logger.info` events in `runHippocampus`, update tests.",
  "non_goals": [
    "Do not change `MAX_HIPPO_STEPS=5`.",
    "Do not change signatures of `getExtractorPrompt`, `runHippocampus`, or `MIN_EXTRACTION_LENGTH`.",
    "Do not touch `packages/agent/src/pipeline/agent-pipeline/post/extractors.ts` or `gate.ts`.",
    "Do not change `WHITELIST_*` validators (PR-A landed).",
    "Do not write any string matching `save token|be efficient|постарайся уложиться|не пиши слишком много|не используй tool без нужды`.",
    "Do not run `git push` / `gh` / docker / ssh.",
    "Do not create new MCP tools or memory layers."
  ],
  "allowed_write_paths": [
    "packages/agent/src/pipeline/agent-pipeline/post/hippocampus.ts",
    "packages/agent/src/pipeline/agent-pipeline/post/prompt.ts",
    "packages/core/src/lib/metrics.ts",
    "tests/hippocampus-extraction.test.ts",
    "tests/hippocampus-cap.test.ts"
  ],
  "read_context": [
    "docs/tasks/refactor/43-prd-hippocampus-rewrite.md:18-24",
    "docs/tasks/refactor/43-prd-hippocampus-rewrite.md:109-115",
    "packages/agent/src/pipeline/agent-pipeline/post/hippocampus.ts",
    "packages/agent/src/pipeline/agent-pipeline/post/prompt.ts",
    "packages/agent/src/pipeline/agent-pipeline/post/extractors.ts:1-30",
    "packages/agent/src/pipeline/agent-pipeline/post/gate.ts:1-30",
    "packages/core/src/lib/metrics.ts"
  ],
  "risk_tier": "public-api",
  "acceptance": [
    "bunx tsc --noEmit",
    "bun test tests/hippocampus-extraction.test.ts tests/hippocampus-cap.test.ts",
    "bun test 2>&1 | tail -3 | grep -q '0 fail'",
    "bun run scripts/check-file-size.ts",
    "bun run scripts/check-deep-imports.ts",
    "test \"$(wc -l < packages/agent/src/pipeline/agent-pipeline/post/hippocampus.ts)\" -le 150",
    "test \"$(wc -l < packages/agent/src/pipeline/agent-pipeline/post/prompt.ts)\" -le 150",
    "grep -cE 'MAX_WRITES_PER_EXCHANGE\\s*=\\s*3' packages/agent/src/pipeline/agent-pipeline/post/hippocampus.ts | grep -qE '^[1-9]'",
    "grep -cE 'limit_exceeded' packages/agent/src/pipeline/agent-pipeline/post/hippocampus.ts | grep -qE '^[1-9]'",
    "grep -cE 'hippocampus_writes_per_exchange|writes_count' packages/core/src/lib/metrics.ts | grep -qE '^[1-9]'",
    "grep -cE 'surprising|non-obvious|actionable' packages/agent/src/pipeline/agent-pipeline/post/prompt.ts | grep -qE '^[3-9]|[1-9][0-9]'",
    "test \"$(grep -cniE 'save token|be efficient|постарайся уложиться|не пиши слишком много|не используй tool без нужды' packages/agent/src/pipeline/agent-pipeline/post/prompt.ts)\" -eq 0",
    "grep -cE 'MAX_HIPPO_STEPS\\s*=\\s*5' packages/agent/src/pipeline/agent-pipeline/post/hippocampus.ts | grep -qE '^[1-9]'",
    "grep -cE 'export function getExtractorPrompt\\b' packages/agent/src/pipeline/agent-pipeline/post/prompt.ts | grep -qE '^[1-9]'",
    "test \"$(git diff --name-only HEAD | grep -cE 'post/(extractors|gate)\\.ts$')\" -eq 0",
    "test \"$(git diff --name-only HEAD | grep -cE 'arbitration/prompts\\.ts$')\" -eq 0"
  ],
  "diff_budget_loc": 240,
  "file_count_max": 5,
  "rollback": "git revert <commit>; pure-textual + counter changes, no schema impact.",
  "escalation_triggers": [
    "Existing extraction tests assert literal old prompt strings — update assertion strings only, not logic",
    "File-cap (150 lines) exceeded after counter+telemetry — extract helper to `post/cap-guard.ts` requires explicit scope expansion, STOP and ask",
    "PR-A whitelist validator blocks all writes in test (validator-collision) — STOP, do not bypass",
    "Anti-economy grep finds banned phrase — rewrite rule, never silence grep",
    "Diff exceeds 240 LOC",
    "`packages/core/src/lib/metrics.ts` shape diverges from existing counters — match the existing pattern, do NOT introduce a new metrics framework"
  ],
  "glossary": {
    "MAX_WRITES_PER_EXCHANGE": "Hard counter cap on `memory_write` tool calls per single exchange (3); separate from `MAX_HIPPO_STEPS=5` (loop steps)",
    "supersede-aware": "If `memory_search` cosine 0.85-0.92 → write with `supersedes_id`; ≥0.92 skip; <0.85 fresh insert",
    "telemetry counter": "`hippocampus_writes_per_exchange` histogram in `packages/core/src/lib/metrics.ts` (file already exists; PRD §3 requires it). Plus `logger.info(\"hippocampus\", \"<event>\", { exchange_id, writes_count, skipped_dup_count })` per CLAUDE.md guardrail #9"
  }
}
```

---

## Packet P3-8 — PR-E persona pass (teamlead synthesis + hippocampus character)

```json
{
  "task_id": "P3-8",
  "goal": "Implement PR-E from `docs/tasks/refactor/44-pre-character.md`: rewrite body of `buildSynthesisSystemPrompt()` (verification clause + direct tone) and prepend hippocampus character paragraph to `getExtractorPrompt()` output (above PR-D rules); pure textual swap.",
  "non_goals": [
    "Do not change signatures of `buildSynthesisSystemPrompt` or `getExtractorPrompt`.",
    "Do not modify `hippocampus.ts`, `extractors.ts`, `gate.ts`, or `arbitration-room.ts`.",
    "Do not change `MAX_HIPPO_STEPS`, `MAX_WRITES_PER_EXCHANGE`, or `MIN_EXTRACTION_LENGTH`.",
    "Do not introduce env vars (no `TEAMLEAD_TONE`).",
    "Do not write any string matching `save token|be efficient|постарайся уложиться|не пиши слишком много|не используй tool без нужды`.",
    "Do not add new imports/exports to either file.",
    "Do not run `git push` / `gh` / docker / ssh."
  ],
  "allowed_write_paths": [
    "packages/agent/src/pipeline/arbitration/prompts.ts",
    "packages/agent/src/pipeline/agent-pipeline/post/prompt.ts",
    "tests/arbitration-room.test.ts",
    "tests/hippocampus-extraction.test.ts"
  ],
  "read_context": [
    "docs/tasks/refactor/44-pre-character.md",
    "packages/agent/src/pipeline/arbitration/prompts.ts",
    "packages/agent/src/pipeline/agent-pipeline/post/prompt.ts",
    "tests/arbitration-room.test.ts",
    "tests/hippocampus-extraction.test.ts"
  ],
  "risk_tier": "ordinary",
  "acceptance": [
    "bunx tsc --noEmit",
    "bun test 2>&1 | tail -3 | grep -q '0 fail'",
    "bun run scripts/check-file-size.ts",
    "bun run scripts/check-deep-imports.ts",
    "test \"$(wc -l < packages/agent/src/pipeline/arbitration/prompts.ts)\" -le 150",
    "test \"$(wc -l < packages/agent/src/pipeline/agent-pipeline/post/prompt.ts)\" -le 150",
    "grep -cE 'рассудительный тимлид|verification|hedges?' packages/agent/src/pipeline/arbitration/prompts.ts | grep -qE '^[3-9]|[1-9][0-9]'",
    "grep -cE 'гиппокамп|surprising|stenographer|архивист' packages/agent/src/pipeline/agent-pipeline/post/prompt.ts | grep -qE '^[3-9]|[1-9][0-9]'",
    "grep -cE 'memory_search.*candidate|MAX_WRITES_PER_EXCHANGE|whitelist' packages/agent/src/pipeline/agent-pipeline/post/prompt.ts | grep -qE '^[1-9]'",
    "test \"$(grep -cniE 'save token|be efficient|постарайся уложиться|не пиши слишком много|не используй tool без нужды' packages/agent/src/pipeline/arbitration/prompts.ts packages/agent/src/pipeline/agent-pipeline/post/prompt.ts)\" -eq 0",
    "grep -cE 'export function buildSynthesisSystemPrompt\\b' packages/agent/src/pipeline/arbitration/prompts.ts | grep -qE '^[1-9]'",
    "grep -cE 'export function getExtractorPrompt\\b' packages/agent/src/pipeline/agent-pipeline/post/prompt.ts | grep -qE '^[1-9]'",
    "test \"$(git diff --name-only HEAD | grep -cE 'post/(hippocampus|extractors|gate)\\.ts$|arbitration-room\\.ts$')\" -eq 0",
    "test \"$(git diff packages/agent/src/pipeline/arbitration/prompts.ts packages/agent/src/pipeline/agent-pipeline/post/prompt.ts | grep -cE '^\\+(import|export)')\" -eq 0"
  ],
  "diff_budget_loc": 100,
  "file_count_max": 4,
  "rollback": "git revert <commit>; pure-textual swap, instant revert safe.",
  "escalation_triggers": [
    "P3-7 (PR-D) not merged — character paragraph would prepend over legacy prompt → conflict, STOP",
    "Existing tests assert literal old synthesis phrases — update assertion strings only, not logic",
    "PR-D rules grep returns 0 matches after edit — character paragraph accidentally overwrote rules",
    "File-cap (150) exceeded — extract HIPPO_CHARACTER const inline, do NOT split into new file",
    "Anti-economy grep finds banned phrase — rewrite, never silence grep",
    "Diff exceeds 100 LOC (pure textual swap should not be larger)"
  ],
  "glossary": {
    "verification clause": "Mandatory sub-rule in synthesis prompt instructing teamlead to flag hedges, name conflicts, and check counter-examples",
    "character paragraph": "5-8 line preamble framing hippocampus as a filter (surprising/non-obvious/actionable), prepended above PR-D rules"
  }
}
```

---

## Packet P3-9 — Curation tests expansion for new fields/behaviors

```json
{
  "task_id": "P3-9",
  "goal": "Expand `tests/memory-curation.test.ts` (or create if absent under same name) with cases covering bi-temporal active filter, edge-walk boost (non-stacking), memory_blocks CRUD, and hippocampus write-cap interaction with curation tools (M-10).",
  "non_goals": [
    "Do not modify M-10 curation tool source files (`packages/agent/src/mcp/tools/memory-curation/*` or wherever they live).",
    "Do not modify `runHippocampus` or `getExtractorPrompt` behavior.",
    "Do not change schema — tests run against live Migration 17 + 18.",
    "Do not introduce new MCP tools.",
    "Do not extend test runner config; use `bun:test` describe/test/expect.",
    "Do not write live tests — file must end `.test.ts`, not `.live.ts`."
  ],
  "allowed_write_paths": [
    "tests/memory-curation.test.ts"
  ],
  "read_context": [
    "tests/memory-bi-temporal-schema.test.ts",
    "tests/rag-bi-temporal-filter.test.ts",
    "tests/rag-edge-walk-boost.test.ts",
    "tests/memory-blocks.test.ts",
    "tests/hippocampus-cap.test.ts",
    "packages/agent/src/mcp/registry"
  ],
  "risk_tier": "ordinary",
  "acceptance": [
    "bunx tsc --noEmit",
    "bun test tests/memory-curation.test.ts",
    "bun test 2>&1 | tail -3 | grep -q '0 fail'",
    "test \"$(grep -cE 'describe\\(|test\\(' tests/memory-curation.test.ts)\" -ge 8",
    "bun run scripts/check-file-size.ts",
    "bun run scripts/check-deep-imports.ts"
  ],
  "file_count_max": 1,
  "rollback": "Delete `tests/memory-curation.test.ts`; no production-code impact.",
  "escalation_triggers": [
    "P3-2..P3-7 not merged — required upstream surface missing, STOP",
    "Curation MCP tools not present in `packages/agent/src/mcp/registry` — M-10 may not have landed; STOP",
    "Test count >12 cases — split file (file-cap 150 lines) and request expanded scope",
    "Diff exceeds 240 LOC"
  ],
  "glossary": {
    "curation tools": "M-10 public MCP tools for memory triage (e.g. memory_supersede, memory_revive); DO NOT modify their source",
    "interaction case": "test that drives a curation MCP call after hippocampus write-cap fires, asserting M-10 rows survive write-cap rejections"
  }
}
```

---

## Out-of-scope cluster reminders

- A2A and frontend changes are **Phase 6+**, not Phase 3.
- BAML / Promptfoo wiring is **Phase 4** — not part of any P3-* packet.
- OpenTelemetry / Langfuse decision is **Phase 5** — telemetry calls in
  P3-7 use existing `packages/core/src/lib/metrics.ts` + plain `logger.info` per CLAUDE.md
  guardrail #9, not OTel.
- Memory-blocks editor UI is **Phase 6 frontend rewrite**; P3-5 lands schema
  + helpers only.

## Definition of "Phase 3 done"

All 9 packets merged with green acceptance, audit log entry in
`docs/02-audit.md` per packet, and:

- `bun test 2>&1 | tail -3 | grep -q '0 fail'`
- `bun run scripts/check-file-size.ts` exit 0
- `bun run scripts/check-deep-imports.ts` exit 0
- `bunx tsc --noEmit` exit 0
- `bun -e 'import {MemoryDB} from "./src/db"; const d=new MemoryDB(":memory:"); console.log(d.db.query("PRAGMA user_version").get())'` reports `{ user_version: 18 }`
- `grep -rnE 'process\\.env\\.NIGHT_CYCLE_MODEL' packages/agent/src/pipeline/night-cycle/ | wc -l` == 1 (single resolver)
