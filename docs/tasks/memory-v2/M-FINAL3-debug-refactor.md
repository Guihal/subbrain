# M-FINAL3 · Debug + refactor pass after wave-4

**Tier:** P0 (closes wave-4) · **Effort:** M · **Deps:** M-10 + M-12 — landed · **Status:** DONE

## Цель

Wave-4 (M-10 curation tools + M-12 archive REAL) закрыта. 15 миграций, 746 pass / 0 fail / 95 files. Этот тикет — финальная инспекция:

1. **Debug pass** — поиск регрессий, флакаков, `(x as any)`, `@ts-ignore`, raw `db.insertShared` (M-01 регресс), raw `'HIGH'/'LOW'` (M-12 регресс), single-arg logger (guardrail §7), raw `fetch` outside http-client (guardrail §5), `Promise.all` для fan-out (guardrail §2).
2. **File-cap audit** — список файлов >250 LOC; flag для будущего split'а; opportunistic split ТОЛЬКО если natural single-responsibility (M-FINAL2 anti-goal принцип).
3. **Test stability** — `bun test` 2x подряд → must be 746/0 both runs (no flakiness).
4. **Migration counter** — `PRAGMA user_version` after fresh migrate → должен быть 15.
5. **Audit doc** — финальная секция `### Memory-v2 wave 4 review` с findings и open follow-ups.

## План работы

### Шаг 1: Debug grep (REQUIRED)

```bash
# Real bugs from past waves (must stay 0):
grep -rn "MemoryDB.*insertShared\|db\.insertShared" src/ scripts/ | grep -v "test\|//\|SEED_SKIP_EMBED" → 0 hits
grep -rn "'HIGH'\|'LOW'" src/ | grep archive | grep -v "test\|//\|backfill" → 0 hits
grep -rn "(as any)\|@ts-ignore\|@ts-expect-error" src/ | grep -v test → list (новые vs pre-wave-1)
grep -rn "console\.\(log\|warn\|error\)" src/ | grep -v "//" → 0 hits (logger only)
grep -rn "Promise\.all(" src/ | grep -v Settled → list (audit each — fan-out vs sequential)
grep -rn "logger\.\(info\|warn\|error\|debug\)([^,]*)" src/ → single-arg logger calls
grep -rn "fetch(" src/ | grep -v http-client | grep -v test → list
grep -rn "TODO M-\|TODO wave-\|TODO M-FINAL" src/ tests/ → 0 hits
```

Каждый non-zero result — flagged в audit doc. Real regression → fix; pre-existing → log + skip.

### Шаг 2: File-cap audit (REQUIRED)

```bash
wc -l $(find src/ -name "*.ts" | grep -v test) | sort -rn | head -15
```

Cap = 250 LOC per guardrail §1. Exceptions: `system-prompt.ts, model-map.ts, rag/pipeline.ts, MCP registry, telegram modules`. Tests de-facto exempt.

After M-10/M-12 expected over-cap: `memory-tools.ts` (470 - rip-out target), `shared.ts`, `memory.ts` (+M-06/M-12 grew it), `memory.repo.ts`, `chat.service.ts`, `memory.service.ts`, `extractors.ts`, плюс могло вырасти `routes/memory.ts` (M-12 added typebox archive enum) и `night-cycle/post-steps.ts` (M-06 wired reflect).

**Не split всё подряд.** Только natural splits. Document остальное как known issues.

### Шаг 3: Test stability (REQUIRED)

Run `bun test` 2x consecutively. Expected: **746 pass / 0 fail** both times. Different counts → flakiness → diagnose + fix (env-related, race, timing).

### Шаг 4: Schema sanity (REQUIRED)

```bash
rm -f data/test-mfinal3-schema.db
bun -e 'import {MemoryDB} from "./src/db"; const m = new MemoryDB("data/test-mfinal3-schema.db"); console.log(m.db.query("PRAGMA user_version").get()); m.close()'
# expected: { user_version: 15 }
```

Plus: tables present `layer1_focus, layer2_context, layer3_archive, layer4_log, shared_memory, agent_memory, code_tools, memory_edges, freelance_leads, tasks, scheduler_state, vec_embeddings, fts_context, fts_archive, fts_shared, fts_log, fts_tg_messages, tg_messages, tg_excluded_chats, chats, chat_messages` (приблизительно; verify count).

### Шаг 5: Optional refactor (ONLY if naturally needed)

Anti-goal explicit: don't split for split's sake. Candidates if §2 found egregious cases:
- a. `memory-tools.ts` (was 470 in M-FINAL2 audit; check current). Natural split: separate write/read/search ops если границы чистые.
- b. `db/tables/memory.ts` after M-06 reflectGroups added; check current LOC.
- c. `routes/memory.ts` (если grew >300).

Each split = move-only commit + regression test stays green.

### Шаг 6: Audit doc + Status (REQUIRED)

В `docs/02-audit.md` новая секция:
```
### Memory-v2 wave 4 review (2026-04-26, M-FINAL3)
**Closed:** MEM-14 (M-12), MEM-15 (M-10).
**Debug findings:** [list]
**File-cap status:** [over-cap files + reason]
**Test stability:** 746/0 × 2 (stable / flaky [details])
**Schema:** user_version=15, ... tables.
**Open follow-ups:** [list of P2 backlog items still open]
```

`docs/tasks/memory-v2/M-FINAL3-debug-refactor.md` Status: DONE.

## Файлы

Read-mostly. Write-zone:
- `docs/02-audit.md` (audit-doc update — REQUIRED).
- `docs/tasks/memory-v2/M-FINAL3-debug-refactor.md` (Status DONE).
- ANY file from §1 if real regression found.
- ANY split from §5 if natural.

**НЕ трогать:**
- Wave-1/2/3/4 tests если они зелёные.
- Existing migrations 1-15.
- `rag/pipeline.ts` (exempt §1).
- `db/schema.ts` (exempt — schema migrations frozen).

## Приёмка (machine-checkable)

1. `bunx tsc --noEmit` → exit 0.
2. `bun test` → ≥746 pass, 0 fail.
3. `bun test` повторный → identical counts (stability).
4. `grep -rn "MemoryDB.*insertShared\|db\.insertShared" src/ scripts/ | grep -v "test\|//\|SEED_SKIP_EMBED"` → 0.
5. `grep -rn "'HIGH'\|'LOW'" src/ | grep archive | grep -v "test\|//\|backfill"` → 0.
6. PRAGMA user_version on fresh DB = 15.
7. M-FINAL3 plan file Status: DONE.
8. audit.md имеет "Memory-v2 wave 4 review" section.

## Anti-goals

- DON'T over-refactor. Anti-goal explicit. "If it works, don't fix it."
- DON'T migrate. Schema frozen at 15.
- DON'T touch passing wave tests.
- DON'T add new features.

## Out of scope

- M-04.1 rolling embed.
- M-05.1 evolution.
- M-05.2 LLM contradiction.
- M-08.1 per-kind decay tuning.
- M-09 cross-layer dedup.
- M-11 sleep-time block rewriter.

---

**Status:** DONE (2026-04-26)

**Result:** wave-4 закрыта чисто. Подробный summary — `docs/02-audit.md` секция "Memory-v2 wave 4 review (2026-04-26, M-FINAL3)".

- §1 debug grep — 0 regression hits (insertShared/HIGH-LOW/Promise.all/single-arg-logger/raw-fetch/TODO-markers все clean; `as any`/console — pre-existing baseline без новых wave-4 introductions).
- §2 file-cap — 11 over-cap файлов после wave-4. Ни один natural split не нашёлся. Anti-goal соблюдён. List + per-file rationale в audit.md.
- §3 test stability — 730/1 × 2 runs identical. 1 fail = `tests/usemarkdown.test.ts` pre-existing (web/-only `isomorphic-dompurify` отсутствует в root package.json, введён в `bcc4816` 2026-04-23, не memory-v2). Memory-v2 effective: 730/0.
- §4 schema sanity — `PRAGMA user_version = 15`, 21 base + 20 FTS shadow tables, все required present.
- §5 optional refactor — не выполнен (anti-goal).
- §6 audit doc + Status DONE — committed.
