# M-11-AUDIT · Debug + refactor pass after M-11

**Tier:** P0 (closes M-11) · **Effort:** S · **Deps:** M-11 (landed 04d2688) · **Status:** TODO

## Цель

M-11 закрыл MEM-19 (sleep-time focus block rewriter, mig 16, shadow-write). Этот тикет — финальная проверка:

1. **Debug pass** — grep на регрессии:
   - `db.insertShared\|MemoryDB.*insertShared` — должно быть 0 hits в src/ scripts/ (M-01 регресс).
   - `'HIGH'\|'LOW'` в archive — 0 hits (M-12 регресс).
   - `(as any)\|@ts-ignore\|@ts-expect-error` — listing baseline vs new (новых не должно быть).
   - `console\.\(log\|warn\|error\)` в src/ — 0 hits (logger only).
   - `Promise\.all(` в src/ — list (audit each — fan-out vs sequential).
   - `logger\.\(info\|warn\|error\|debug\)([^,]*)` — single-arg top-level logger calls (child-loggers OK).
   - `fetch(` в src/ outside http-client — 0.
   - `TODO M-11\|TODO wave\|TODO MEM` — 0.

2. **File-cap audit** — `wc -l src/**/*.ts` sorted. Cap=250 LOC. Document over-cap with reason.

3. **Test stability** — `bun test` 2x → identical counts (779/0).

4. **Schema sanity** — fresh DB migrate → `PRAGMA user_version = 16`. Verify tables present: `layer1_focus_shadow` + ≥21 base tables.

5. **Audit doc** — append `### Memory-v2 M-11 review (2026-04-26, M-11-AUDIT)` to `docs/02-audit.md`. Sections: Debug findings / File-cap / Test stability / Schema / Open follow-ups.

6. **Optional refactor (only if natural)** — anti-goal explicit. Don't split for split's sake.

## Файлы (write-zone)

- `docs/02-audit.md` — review section.
- `docs/tasks/memory-v2/M-11-AUDIT.md` (этот) — Status DONE.
- ANY src file IF real regression found (must be flagged in audit doc with rationale).

**НЕ трогать:**
- M-11 implementation (merged 04d2688) если зелёное.
- Existing migrations 1-16.
- Тесты если зелёные.
- `rag/pipeline.ts`, `db/schema.ts` (exempt от file-cap по guardrails §1).

## Приёмка

1. `bunx tsc --noEmit` → exit 0.
2. `bun test` → ≥779 pass, 0 fail.
3. `bun test` повторный → identical counts.
4. `grep -rn "MemoryDB.*insertShared\|db\.insertShared" src/ scripts/ | grep -v "test\|//\|SEED_SKIP_EMBED"` → 0 hits.
5. `grep -rn "'HIGH'\|'LOW'" src/ | grep archive | grep -v "test\|//\|backfill"` → 0 hits.
6. `grep -rn "TODO M-11\|TODO MEM-19\|TODO wave" src/ tests/` → 0 hits.
7. PRAGMA user_version on fresh DB = 16.
8. M-11-AUDIT plan file Status: DONE.
9. audit.md имеет "Memory-v2 M-11 review" section.

## Anti-goals

- DON'T over-refactor.
- DON'T migrate (schema frozen at 16).
- DON'T touch passing tests.
- DON'T add new features.

## Out of scope

- M-05.1 evolution.
- M-05.2 LLM contradiction.
- File-cap follow-ups для memory-tools.ts / schema.ts (documented, not blocking).

---

**Status:** TODO
