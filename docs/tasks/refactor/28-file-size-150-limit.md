# 28 — File-size 150 + SoC tightening (master task)

**Status:** OPEN — план одобрен 2026-04-27, исполнение стартует с PR P0-A.
**Audit-tracker:** [FILE-SIZE-1](../../02-audit.md#file-size-1--open--file-cap-150--soc-enforcement-introduced-2026-04-27).
**Введён:** 2026-04-27, RLM cycle (`/task --complex`), plan_iter=2 (ok).

## Цель

1. Hard cap **150 строк** на файлы `src/**/*.ts`, `web/app/**/*.{ts,vue}`, `scripts/**/*.ts`. Снижено с 250 (Глава 1).
2. Three-layer SoC: data (`db/tables/*`, `repositories/*`) / logic (`services/*`, `pipeline/*`, `mcp/tools/*`, `scheduler/*`) / view (`routes/*`, `mcp/transport.ts`, `mcp/mcp-protocol.ts`, `web/app/pages|components`). Cross-layer rules — см. [CLAUDE.md §1a](../../../CLAUDE.md).
3. No-SQL-in-routes / no-fetch-in-pages.
4. Минимальная связанность через единственный публичный `index.ts` per split-folder; deep-imports запрещены за исключением `import type`.
5. Composable single-responsibility (data | UI-state | transform).
6. Whitelist с per-file caps — single source `scripts/check-file-size.ts`, mirror в [SKILL.md](../../../.claude/skills/subbrain-guardrails/SKILL.md).

## Принципы (фиксируются в [CLAUDE.md §1](../../../CLAUDE.md) + [SKILL.md § "1. File size + split"](../../../.claude/skills/subbrain-guardrails/SKILL.md))

См. [docs/01-refactor-plan.md Часть VIII](../../01-refactor-plan.md). Whitelist 9 паттернов с per-file caps. `rag/pipeline.ts` — temporary "≤700 OPEN" до W4-1.

## Roadmap (PR checkboxes)

### P0-A — docs/rules update (foundation)

- [x] CLAUDE.md §1 переписан + добавлен §1a (three-layer SoC + cross-layer rules)
- [x] `.claude/skills/subbrain-guardrails/SKILL.md` § "1. File size + split" расширен whitelist-таблицей + Vue SFC clarification + three-layer SoC mirror + composable SR + entry-point rule + 5 новых строк в Red Flags
- [x] `docs/02-audit.md` — FILE-SIZE-1 OPEN entry
- [x] `docs/01-refactor-plan.md` — Часть VIII (Глава 3)
- [x] `docs/tasks/refactor/28-file-size-150-limit.md` — этот файл
- [x] `docs/tasks/refactor/README.md` — Глава 3 секция

### P-C — enforcement (parallel with Wave 1) ✅ DONE (commit bae1377, 2026-04-28)

- [x] `scripts/check-file-size.ts` — `CANONICAL_WHITELIST` + `CANONICAL_GLOB_WHITELIST` + `TRANSITIONAL_WHITELIST` (47 rows locked at exact LOC). Default **STRICT**. Канонический whitelist может быть relaxed транзитивным через `Math.max` (logger.ts pre-microPR).
- [x] `scripts/check-deep-imports.ts` — regex для import statements, `import type` skip, ≥3 segments past `..` + parent `index.ts` exists → violation. `TRANSITIONAL_DEEP_IMPORTS` set для 4 known cases (code-tools sandbox/validators, mcp/snapshot, prune/tasks-classify) — ждут barrel re-exports в W2/W3.
- [x] `tests/repo-rules.test.ts` (bun:test, 5 тестов): file-size cap, deep-imports, no SQL in routes (transitional whitelist tasks.ts+logs.ts), no fetch in pages, whitelist-sync SKILL.md ↔ CANONICAL_WHITELIST. Все 5 зелёные.
- [x] Pre-commit hook (`scripts/{pre-commit,install-hooks}.sh`) — запускает оба check'а STRICT. Установка: `bash scripts/install-hooks.sh`. Bypass: `SKIP_GUARDRAILS=1 git commit ...`. Задокументирован в SKILL.md §1.
- [x] DoD: STRICT с самого P-C по user override §F.4 (no `SKIP_STRICT` shortcut). 5 trivial deep-imports fixed inline (telegram, mcp, night-cycle/steps).

### Wave 1 — frontend low-risk (5 PR, параллельны)

- [ ] **W1-1** `web/app/composables/useChatStream.ts` (151) → `useChatStream/{index,parser,state,types}.ts`
- [ ] **W1-2** `web/app/composables/useTasks.ts` (167) → `useTasks/{index,api,filters}.ts`
- [ ] **W1-3** `web/app/composables/useMemoryEditor.ts` (201) → `useMemoryEditor/{index,api,validation,state}.ts`
- [ ] **W1-4** `web/app/pages/memory.vue` (248) → ≤150 + `components/memory/{MemoryFilters,MemoryToolbar}.vue` + `composables/useMemoryPage.ts`
- [ ] **W1-5** `web/app/pages/tasks.vue` (245) → ≤150 + `components/tasks/{TaskFilters,TaskList}.vue` + `composables/useTasksPage.ts`

### Wave 2 — backend SoC smells (4 PR)

- [ ] **W2-1** `src/routes/logs.ts` SQL → `repositories/log.repo.ts` методы (`listRecent`, `searchByLevel`, `getById`)
- [ ] **W2-2** `src/routes/tasks.ts` SQL → `repositories/task.repo.ts` методы + split (228→≤150)
- [ ] **W2-3** `src/mcp/tools/memory-tools.ts` (472) → `mcp/tools/memory/{index,shared,context,archive,agent,log,embed}.ts`
- [ ] **W2-4** `src/pipeline/night-cycle/prune/stray-tasks.ts` (164) → `stray-tasks/{index,fetch,classify,prune}.ts`

### Wave 3 — big modules (10 PR; STRICT internal order)

**Order (strict, см. § F.6 user override):** db (W3-3 ∥ W3-4) → repo (W3-2) → service (W3-1). W3-5..W3-10 параллельны после P0-A.

- [ ] **W3-3** `src/db/tables/memory.ts` (451) → `db/tables/memory/{index,schema-helpers,insert,update,select,delete}.ts`. Migration safety: `rm -f data/test.db && bun test tests/migration*.test.ts tests/schema*.test.ts` зелёные.
- [ ] **W3-4** `src/db/tables/shared.ts` (396) → `db/tables/shared/{index,insert,update,select,delete}.ts`. Migration safety same as W3-3.
- [ ] **W3-2** `src/repositories/memory.repo.ts` (380) → `repositories/memory/{index,queries,search-shared,search-context,search-archive,crud}.ts`. Layer-boundary тест ↗.
- [ ] **W3-1** `src/services/memory.service.ts` (380) → `services/memory/{index,insert,update,search,link-related,dedupe}.ts`.
- [ ] **W3-5** `src/pipeline/arbitration-room.ts` (420) → `pipeline/arbitration/{index,prompts,weights,dispatch,synthesis}.ts`. `Promise.allSettled` обязательно.
- [ ] **W3-6** `src/mcp/executor.ts` (361) → `mcp/executor/{index,dispatch,context,wiring}.ts`. (depends on W2-3 для tools/memory структуры)
- [ ] **W3-7** `src/mcp/playwright-client.ts` (314) → `mcp/playwright/{index,lifecycle,actions/{click,type,navigate,snapshot,evaluate}.ts}`.
- [ ] **W3-8** `src/telegram/bot.ts` (343) → `telegram/bot/{index,commands,routing,notify}.ts`. **`notify(chatId, msg)` — public logic-API** (см. SoC §3 cross-layer rule).
- [ ] **W3-9** `src/telegram/userbot.ts` (348) → `telegram/userbot/{index,cache,search,parse}.ts`.
- [ ] **W3-10** `src/services/chat.service.ts` (323) → `services/chat/{index,rag-context,model-select,sse-format}.ts`. **HOT PATH** — обязательный full-test + integration.live + локальный smoke.

### Wave 4 — rag/pipeline split (1 PR)

- [ ] **W4-1** `src/rag/pipeline.ts` (699) → `rag/pipeline/{index,forgetting,boost-persona,boost-salience,rrf,dedupe,rerank-call}.ts`. Whitelist `rag/pipeline/index.ts:200`. **Bench invariants:** `scripts/bench-rag.ts` (новый, сохраняется в репо) — 100 итераций `rag.search`, p50/p95/p99 latency + `rerank_calls_per_search`. Регрессия p95 ≤5%, rerank_calls неизменно.

### P-C2 — strict-mode flip + close

- [ ] Удалить `SKIP_STRICT` из `tests/repo-rules.test.ts` (или подтвердить, что не оставляли — было STRICT с самого P-C по user override §F.4).
- [ ] FILE-SIZE-1 → ✅ CLOSED в `docs/02-audit.md`.
- [ ] Strikethrough записи в Часть VIII `docs/01-refactor-plan.md`.
- [ ] `Status: DONE` в этом файле.

### MicroPR — squeeze logger.ts ≤200

- [ ] `src/lib/logger.ts` (262 → ≤200) без split — uglify multi-line + сжать redundant patterns. Whitelist cap 200.

## Принятые user-overrides (§F плана)

| # | Question | Default | User override |
|---|---|---|---|
| F.1 | Cap включает blank+comments? | да | **да** |
| F.2 | logger.ts whitelist 200 + microPR | да | **да** |
| F.3 | system-prompt.ts whitelist 300 | да | **да** |
| F.4 | P-C soft-mode до Wave 4? | soft | **STRICT** с самого P-C |
| F.5 | Pre-commit hook? | нет (опционально) | **да, добавить** |
| F.6 | Wave 3 strict db→repo→service? | strict | **strict** |
| F.7 | Entry naming index.ts vs mod.ts | index.ts | **index.ts** (default) |
| F.8 | Backward-compat re-exports? | нет | **нет** (отказ от temporary re-exports) |
| F.9 | mcp/registry/*.tools.ts whitelist 250 per-file | да | **да** |
| F.10 | Bench-RAG saved? | да | **да** |

## Acceptance (закрытие FILE-SIZE-1)

1. `bun test tests/repo-rules.test.ts` все 5 тестов strict-зелёные.
2. `bun run scripts/check-file-size.ts` exit 0 (STRICT mode default).
3. `bun run scripts/check-deep-imports.ts` exit 0.
4. `bunx tsc --noEmit` exit 0.
5. `bun test` ≥ baseline-passed (pre-Wave-1 snapshot), 0 failed.
6. Полный manual smoke на dev-сервере: chat (stream + non-stream) → /memory admin → autonomous agent 3 шага → night-cycle trigger → freelance leads page (если есть). Без regress.
7. Все Wave 1-4 PR смерджены, P-C2 закрыт, FILE-SIZE-1 ✅ в audit.

## Rollback strategy

Каждый PR — отдельная ветка `refactor/28-w<N>-<short>`. Rollback одного PR — `git revert <sha> && (если задело prod) ssh root@109.120.187.244 "cd /opt/subbrain && git pull && docker compose build && docker compose up -d"`. Wave 4 — особенно осторожно: `rag/pipeline.ts` — горячий путь.
