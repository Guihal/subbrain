# Subbrain wave plan — 2026-05-05

> Live status board для декомпозиции `docs/specs/subbrain-main.md` на Kimi-grade
> packets. Каждая строка ниже = packet doc. Этот файл обновляется по мере
> прогресса waves. Источник истины для оркестратора.

## Status legend

- `DRAFT-PENDING` — packet doc ещё не написан.
- `DRAFT-IN-FLIGHT` — Sonnet subagent пишет packet decomposition.
- `DRAFT-FIRST-PASS` — Sonnet wrote, no Codex critic yet. Likely needs-fix.
- `CRITIC-NEEDS-FIX` — Codex critic returned issues, fix in progress/pending.
- `CRITIC-PASSED` — Codex critic + fix loop landed; ready for Kimi.
- `KIMI-DISPATCHED` — Kimi worker запущен на одном из packets.
- `KIMI-DONE` — все packets из doc'а закрыты, фаза merged.
- `BLOCKED` — нужен strong-model decision или нерешённый upstream вопрос.

## Critic loop policy

Empirical finding 2026-05-05: 4/4 docs that went through Codex critic returned
**needs-fix** verdict on first pass. Sonnet skeleton drafts miss code-level
details (deps not in package.json, line numbers wrong, schema collisions,
ESM/CJS mismatch, fail-open security defaults). Critic+fix loop catches these.

**Rule:** No Kimi dispatch on `DRAFT-FIRST-PASS` doc. All dispatched packets
must be `CRITIC-PASSED` or have parent override.

## Wave 1 — Foundation (sequential within doc, parallel across docs)

| Phase | Packet doc | Packets | Escalations | Status | Notes |
|---|---|---|---|---|---|
| **Phase 0** Docs sync | [`agent-teams/00-docs-sync.md`](../tasks/agent-teams/00-docs-sync.md) | 3 | 0 | CRITIC-PASSED | round 1 critic→fix done; stale spots README 3→12, AGENTS 2→5 |
| **Phase 1** Bifrost gateway | [`agent-teams/01-bifrost-gateway.md`](../tasks/agent-teams/01-bifrost-gateway.md) | 6 (717 lines) | 0 | CRITIC-PASSED | round 1 critic→fix done; TBDs resolved (`maximhq/bifrost:latest`, port 8080, JSON config); 1 genuine TBD remains (custom-provider base_url shape) |
| **A1** Workspaces split | [`runtime-arch/A1-workspaces-split.md`](../tasks/runtime-arch/A1-workspaces-split.md) | 13 (was 8) | mechanical halts on schema/cycles | CRITIC-PASSED | round 1 critic→fix done; +5 packets for cycle-prep, A2-server cycle break, guardrail scan-roots, mcp View/Logic split, A1-5 split into 4 sub-packets |
| **Phase 4** BAML + Promptfoo | [`agent-teams/03-baml-promptfoo.md`](../tasks/agent-teams/03-baml-promptfoo.md) | 7 (was 6) | 0 | CRITIC-PASSED | round 1 critic→fix done; BAML pinned `0.222.0`; ESM `module_format`; custom JS provider for promptfoo; additive-only enforced via git-diff guards |
| **Phase 5** Observability | [`agent-teams/04-observability.md`](../tasks/agent-teams/04-observability.md) | 6 | P5-1 strong-only decision **RESOLVED** | CRITIC-PASSED | P5-1: Langfuse chosen, `docs/specs/observability-choice.md` written; round 2 critic ok (11/11 findings); P5-3/P5-4 file-cap escalation explicit; P5-6 unblocked (decision doc exists) |

## Wave 2 — Build-out (parallel after W1 foundation merged)

| Phase | Packet doc | Packets | Escalations | Status | Notes |
|---|---|---|---|---|---|
| **Phase 2** Agent-pool | [`agent-teams/06-agent-pool.md`](../tasks/agent-teams/06-agent-pool.md) | 7 → 9 (P2-5a + P2-7a inserted) | 1 schema (P2-1 mig19) + 2 strong-model pre-packets | CRITIC-PASSED | round 2 critic ok after line-168 mig19 glossary fix; P2-2 auth.ts path, P2-4 idempotent terminate via agent-meta.tools.ts, P2-5a expands AgentLoopRequest (strong-only), P2-7a creates src/lib/mutex.ts (strong-only); mig17 reassigned per Migration ownership table below |
| **Phase 3** Memory cluster | [`agent-teams/02-memory-bi-temporal.md`](../tasks/agent-teams/02-memory-bi-temporal.md) | 9 → ~10 (593 lines) | 2 schema (P3-2 mig17, P3-5 mig18); M-12 already DONE in mig15 | CRITIC-PASSED (round 3) | round 3: 5 mechanical fixes (shared-memory paths, schema.ts range, check-deep-imports, P3-9 JSON, definition of done); schema 17/18 ownership locked; NIGHT_CYCLE_MODEL resolver plan present; predicate parens verified |
| **Phase 6** A2A arbitration | [`agent-teams/05-a2a-arbitration.md`](../tasks/agent-teams/05-a2a-arbitration.md) | 6 (~290 lines) | 1 schema (P6-3); transport TBD | CRITIC-PASSED (mechanical) | round 3: 6 mechanical fixes (file-cap escalations, guardrails added, paths corrected, fish compat, duplicate key); 2 strong-model TBDs remain: `<A2A_TRANSPORT>` blocks P6-4, schema choice (transcripts table vs artifact_payload) blocks P6-3 |
| **A2** Plugin runtime + hooks | [`runtime-arch/A2-plugin-runtime.md`](../tasks/runtime-arch/A2-plugin-runtime.md) | 9 (579 lines) | 2 security (A2-6 code-tool-guards, A2-7 tg-gates — integration tests mandatory) | CRITIC-PASSED (mechanical) | round 3: 7 mechanical fixes applied; 1 strong-model item (CLAUDE.md §8 drift — already fixed); blocks Phase 8a per 8a critic finding #3 |

## Wave 3 — Security tier (parallel, can start after Phase 1 merged)

| Phase | Packet doc | Packets | Escalations | Status | Notes |
|---|---|---|---|---|---|
| **Phase 8a** Approval flow | [`agent-teams/08a-approval-flow.md`](../tasks/agent-teams/08a-approval-flow.md) | 7 → ~8 | 1 schema (8a-1) + 3 security (8a-2/3/4) | CRITIC-PASSED (round 3) | round 3: 14 fixes — `packages/agent/` → `src/pipeline/agent-loop/` path rewrite, ToolResult aligned to current `{success,error}` shape with A2-5 adapt note, migration 20 claimed, `src/db/index.ts` removed from 8a-1 allowed paths, line numbers corrected (deps.ts 338-367), guardrails + check-file-size + check-deep-imports added to all 7 packets, JSON syntax errors fixed (duplicate guardrails keys, missing commas), `APPROVAL_DISABLE` env documented, all `kind:"rejected"` → `{success:false}` |
| **Phase 8c** SQLite backup | [`agent-teams/08c-sqlite-backup.md`](../tasks/agent-teams/08c-sqlite-backup.md) | 6 | ALL 6 escalate (5 db + 1 security) | CRITIC-PASSED (mechanical) | round 3: 12 mechanical fixes (guardrails in all 6 packets, paths corrected to bootstrap.ts/db/index.ts, regex portable, `--help` removed, line ranges tightened); all-escalate verified (`escalate_to_strong_model: true` every packet); never runs on Kimi |
| **Phase 8e** Telegram PII gates | [`agent-teams/08e-telegram-pii.md`](../tasks/agent-teams/08e-telegram-pii.md) | 7 | 1 schema + 1 db + 4 security | CRITIC-PASSED (mechanical) | round 3: 11 fixes (migration 17→20, removed fake barrel file, view→DML fix, SoC rewrite, guardrails added, pre-sanitization guard, test cleanup, whitelist hints); 3 strong-model items: ToolResult shape ambiguity, policy field layering, 8e-3/8e-5 deploy sequencing |

## Deferred — выйдут в следующий round

| Phase | Reason |
|---|---|
| **Phase 7** Frontend rewrite | depends on stable Bifrost+pool+memory APIs (Wave 1+2 merged) |
| **A3** External plugin loader | depends on A2 done + 1 internal plugin proven |
| **A4** First external plugin | out-of-round (smoke test, post-A3) |
| **Phase 8b** MCP allowlist | foundation for marketplace — defer until allowlist policy clear |
| **Phase 8d** Scheduler hardening | idempotent restart already partial; defer until pain |
| **Phase 8f** Cost controls | wait until autonomous loop hits real budget pain |

## Dependency graph (compact)

```text
Wave 1 (parallel inside)
  P0 docs ────┐
  P1 Bifrost ─┼─→ Wave 2 build-out
  A1 split ───┘    P2 pool, P3 memory, P6 A2A, A2 hooks (parallel)
  P4 BAML ────────────┐
  P5 observability ───┴─→ post-W2 enhancements

Wave 3 (security, parallel — can start after P1 stable)
  8a approval ─┐
  8c backup ───┼─→ unblocks "serious autonomy"
  8e PII ──────┘

Deferred → next round
  P7 frontend, A3 loader, 8b MCP allowlist, 8d/8f
```

## Migration ownership (schema-tier serialization)

`PRAGMA user_version` is monotonic — only one packet may own each migration number. Conflicts cause `migrate()` to abort or silently double-write. Recorded ownership (single source of truth):

| Migration | Owner packet | Doc | Notes |
|---|---|---|---|
| **17** | P3-2 (memory bi-temporal nullable cols) | `agent-teams/02-memory-bi-temporal.md` | First-claim; locked. Other packets MUST advance to 18+ |
| **18** | P3-5 (memory_blocks table) | `agent-teams/02-memory-bi-temporal.md:380` | Hard-locked: `escalation_triggers` aborts if user_version != 17 |
| **19** | P2-1 (agent_tasks + pool tables) | `agent-teams/06-agent-pool.md` | **Reassigned from 17 → 19** to resolve P2-1↔P3-2 collision; merge-dependency: P3-5 must merge first |
| **20+** | TBD | — | Reserved for Phase 6 P6-3 (transcripts) and Phase 8a 8a-1 (approval requests) when they critic-pass |

Hard rule: any new schema-tier packet MUST consult this table BEFORE writing a `Migration NN` block. If a packet doc lists a number already owned, fix the doc, never the schema.

## Hard rules for Kimi dispatch

1. **Never dispatch a packet whose risk tier is `db`/`schema`/`security` to Kimi** — every such packet has `escalate_to_strong_model` flag. Strong model (Opus/GPT-5) или operator pre-approval before run.
2. **Never dispatch packets with unresolved `<TBD-…>` placeholders**. Parent fills placeholder before dispatch (e.g. `<TBD-Bifrost-IMAGE>`, `<BAML_VERSION>`, `<PII_MODEL>`, `<PERMISSION_ASK_UX>`, `<A2A_TRANSPORT>`).
3. **Preserve all guardrails from CLAUDE.md** — Kimi packet acceptance must include `bun run scripts/check-file-size.ts`, `bun run scripts/check-deep-imports.ts`, `bunx tsc --noEmit`. If acceptance is missing one, packet is incomplete.
4. **Wave boundaries are merge-gates, not dispatch-gates.** Within a wave, packets can be parallel. Between waves — wait for upstream merged.
5. **Each Kimi run gets `dispatch-task-subagent` skill** — guarantees /task RLM cycle + caveman + parent-side critic review.
6. **Failure packet is success.** If Kimi returns `FAIL: <category>: <reason>`, that's correct behavior. Do NOT redispatch same packet — fix the spec/packet first.

## Tracking — 2026-05-05 evening

12 Sonnet decomposition agents fired in parallel (Waves 1+2+3). All 12 returned
DRAFT-READY. Total: **64 Kimi packets across 12 phase docs**. Critic pass on
Bifrost + A1 in flight.

### Per-phase findings

- **Phase 0** — 3 packets. README stale in 3 spots (not 1); AGENTS ASCII (lines
  175-205) also lists MiniMax-as-primary; deletions already on disk per
  `git status`.
- **Phase 1 Bifrost** — 6 packets, 492 lines. TBDs: `<TBD-Bifrost-IMAGE>`,
  `<TBD-Bifrost-URL>`. Rate-limiter reuses `nvidia` limiter (P1-6 revisit).
- **A1 workspaces** — 8 packets. Decisions surfaced: `src/services/` →
  `packages/agent`, `src/app/` → `packages/server`, leftover `src/lib/*` →
  `packages/core`, `src/rag` + `src/telegram` → `packages/agent`. Cross-package
  imports use `@subbrain/<pkg>` (no path alias).
- **Phase 4 BAML** — 5 actionable + 1 deferred (P4-6 pool artifact blocked on
  Phase 2). TBD: `<BAML_VERSION>` resolved from package.json.
- **Phase 5 observability** — 6 packets. P5-1 = strong-model decision; P5-6
  depends on P5-1 (acceptance gate).
- **Phase 2 agent-pool** — 7 packets, 491 lines. Wraps PRDs 39-42; one schema
  escalation (P2-1).
- **Phase 3 memory** — 9 packets, 593 lines. **Critical reconciliation:** M-12
  already DONE in `src/db/schema.ts:820-862` (Migration 15) — P3-1 reduced to
  verify-only. Bi-temporal additive nullable cols (mig 17), `memory_blocks`
  separate table (mig 18).
- **Phase 6 A2A** — 6 packets. Transport unresolved → `<A2A_TRANSPORT>` blocks
  P6-4. Schema choice (transcripts table vs `agent_tasks.artifact_payload`)
  blocks P6-3.
- **A2 plugin runtime** — 9 packets, 579 lines. Critical security: A2-6
  code-tool-guards + A2-7 tg-gates require integration tests reproducing
  original poisoning/spam scenarios; STOP-do-not-merge if not reproducible.
  `permission.ask` UX deferred to `<PERMISSION_ASK_UX>` (default sync return-true).
- **Phase 8a approval** — 7 packets. 1 schema + 3 security. Async resume only.
  Operator chat fallback `APPROVAL_OPERATOR_CHAT_ID ?? TG_OWNER_CHAT_ID`.
  Audit reuses `metrics_log`.
- **Phase 8c backup** — 6 packets. ALL escalate to strong model. **Critical
  finding:** `bun:sqlite` exposes only `serialize()`/`deserialize()` (memory),
  no `db.backup()`. Locked to `VACUUM INTO`. Schema anchor: `user_version=16`
  per `src/db/schema.ts:879`.
- **Phase 8e PII** — 7 packets. 1 schema + 1 db + 4 security. **Locked
  decisions:** regex-only v1 (gliner-pii not verified live in NIM); single
  `tg_chats` table with SQL view `tg_excluded_chats` for back-compat;
  plaintext dropped post-scrub; new chat default policy = `metadata_only`.

### Aggregate

- **Total Kimi packets:** 64
- **Schema-tier escalations:** 7 (Phase 2 P2-1, Phase 3 P3-2/P3-5, Phase 6
  P6-3, Phase 8a 8a-1, Phase 8e 8e-3, Phase 8c 5/6 packets are db tier)
- **Security-tier escalations:** 12 (A2-6, A2-7, Phase 8a 8a-2/3/4, Phase 8c
  8c-4, Phase 8e 8e-1/2/5/6, Phase 5 P5-1)
- **DB-tier escalations:** 5 (Phase 8c 8c-1/2/3/5/6, Phase 8e 8e-4) — overlaps
  schema/db category boundary
- **Strong-model-only packets:** ≥18 (must NEVER dispatch to Kimi)
- **TBD placeholders to resolve before dispatch:** 7 (`<TBD-Bifrost-IMAGE>`,
  `<TBD-Bifrost-URL>`, `<BAML_VERSION>`, `<PII_MODEL>` (locked to regex),
  `<PERMISSION_ASK_UX>`, `<A2A_TRANSPORT>`, P5-1 Langfuse-vs-Laminar decision)

## Critic loop log

Round 1 (4/4 docs needed-fix → fix landed):
- **Phase 1 Bifrost** — 7 critical + 4 important → fixed; injection option B locked, JSON config (no yaml dep), heartbeat citations corrected, fallback locked to `UpstreamExhaustedError`.
- **A1 workspaces** — 4 critical + 6 important → fixed; +5 packets for cycle prep, agent→server interface break, guardrail scan-roots, mcp View/Logic split, A1-5 sub-split.
- **Phase 0 docs sync** — 4 critical + 2 important → fixed; stale-spot inventory expanded README 3→12, AGENTS 2→5.
- **Phase 4 BAML** — 3 critical + 4 important → fixed; BAML pinned `0.222.0`, ESM enforced, custom JS provider, fallback chain removed.

Round 2 (in flight):
- **Phase 3 memory** — 5 critical + 4 important → fix in flight; schema 17/18 collision, shared-memory paths, NIGHT_CYCLE_MODEL central resolver, predicate parens, rag/pipeline path correction.
- **Phase 8a approval** — 4 critical + 3 important → fix in flight; spam-gate ordering, `tg_send_report` gap, A2 hard dep, ToolResult shape align.
- **A2 plugin runtime** — critic in flight (blocks Phase 8a final).

Round 3 (untreated):
- **Phase 5 observability**, **Phase 2 agent-pool**, **Phase 6 A2A**, **Phase 8c backup** (all-escalate), **Phase 8e PII** — DRAFT-FIRST-PASS. Sonnet first-pass quality. **Recommend critic pass before any Kimi dispatch.** Empirical: 100% of treated docs needed fixes.

## Next steps (for parent / human)

1. **Pre-fill TBD placeholders** before any Kimi dispatch (`<A2A_TRANSPORT>`, `<PERMISSION_ASK_UX>`, P5-1 Langfuse-vs-Laminar, Bifrost custom-provider base_url shape).
2. **First-Kimi-dispatch candidate:** Phase 0 packets (P0-1..P0-3) — lowest risk, CRITIC-PASSED, no schema/security tier.
3. **Wave-1 merge gate:** P0+P1+A1+P4 (all CRITIC-PASSED) merged → unblocks W2.
4. **Run critic round 3** on Phase 5, Phase 2, Phase 6, Phase 8e before dispatching their packets.
5. **Schema-tier packets** (7 across all docs) require strong-model (Opus/GPT-5) execution, never Kimi.
6. **Security-tier packets** (12 across all docs) require integration-test reproducibility before merge.
7. **All 5 db-tier packets in Phase 8c** must be operator-authorized; data-loss territory.
8. **A2 critic-fix landing → 8a fix re-validation** required (8a inherits A2 contract).
