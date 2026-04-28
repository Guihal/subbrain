# 28 — File-size 150 + SoC tightening (master task)

**Status:** DONE — closed 2026-04-28. All Wave 1-4 + microPR + P-C2 merged. FILE-SIZE-1 ✅ in audit.
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

### Wave 1 — frontend low-risk (5 PR, параллельны) ✅ DONE

- [x] **W1-1** `web/app/composables/useChatStream.ts` → split-folder
- [x] **W1-2** `web/app/composables/useTasks.ts` → split-folder
- [x] **W1-3** `web/app/composables/useMemoryEditor.ts` → split-folder
- [x] **W1-4** `web/app/pages/memory.vue` → ≤150 + components + composable
- [x] **W1-5** `web/app/pages/tasks.vue` → ≤101 + Toolbar/Footer + useTasksPage

### Wave 2 — backend SoC smells (4 PR) ✅ DONE

- [x] **W2-1** `src/routes/logs.ts` SQL → repository methods
- [x] **W2-2** `src/routes/tasks.ts` SQL → `task.repo.ts` + split (228→139)
- [x] **W2-3** `src/mcp/tools/memory-tools.ts` → `mcp/tools/memory/` folder
- [x] **W2-4** `src/pipeline/night-cycle/prune/stray-tasks.ts` → split-folder

### Wave 3 — big modules (10 PR; STRICT internal order) ✅ DONE

**Order (strict, см. § F.6 user override):** db (W3-3 ∥ W3-4) → repo (W3-2) → service (W3-1). W3-5..W3-10 параллельны после P0-A.

- [x] **W3-3** `src/db/tables/memory.ts` → `db/tables/memory/` folder (456fba2)
- [x] **W3-4** `src/db/tables/shared.ts` → `db/tables/shared/` folder (c84fe8e)
- [x] **W3-2** `src/repositories/memory.repo.ts` → `repositories/memory/` folder (1217120)
- [x] **W3-1** `src/services/memory.service.ts` → `services/memory/` folder (bb95645)
- [x] **W3-5** `src/pipeline/arbitration-room.ts` → `pipeline/arbitration/` folder (43a3ada)
- [x] **W3-6** `src/mcp/executor.ts` → `mcp/executor/` folder (c9c6e60)
- [x] **W3-7** `src/mcp/playwright-client.ts` → `mcp/playwright/` folder (f8ab5b9)
- [x] **W3-8** `src/telegram/bot.ts` → `telegram/bot/` folder (d4f9686)
- [x] **W3-9** `src/telegram/userbot.ts` → `telegram/userbot/` folder (ddfd180)
- [x] **W3-10** `src/services/chat.service.ts` → `services/chat/` folder (61e5380) — HOT PATH

### Wave 4 — rag/pipeline split (1 PR) ✅ DONE

- [x] **W4-1** `src/rag/pipeline.ts` → `rag/pipeline/` folder (1a9332d). Whitelist `rag/pipeline/index.ts:200`. Bench invariants deferred (run from prod after deploy).

### P-C2 — strict-mode flip + close ✅ DONE

- [x] STRICT было by default с P-C (user override §F.4); no `SKIP_STRICT` to remove.
- [x] FILE-SIZE-1 → ✅ CLOSED в `docs/02-audit.md`.
- [x] Strikethrough записи в Часть VIII `docs/01-refactor-plan.md`.
- [x] `Status: DONE` в этом файле.

### MicroPR — squeeze logger.ts ≤200 ✅ DONE

- [x] `src/lib/logger.ts` 262 → 190 LOC (bc8008a). Whitelist cap 200 covers it.

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
