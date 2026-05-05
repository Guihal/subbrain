# 28-W4-1 — split `rag/pipeline.ts` (699 → split-folder) + bench-rag invariants

**Status:** OPEN. Master: [28-file-size-150-limit.md](28-file-size-150-limit.md) Wave 4 (final wave before P-C2).

## Цель

Разбить `packages/agent/packages/agent/src/rag/pipeline/index.ts` (699 LOC, transitional cap 700) на split-folder. Public API = `RAGPipeline` class + helpers. Whitelist: `rag/pipeline/index.ts:200`. **Bench invariants**: `scripts/bench-rag.ts` (новый, сохраняется в репо).

## Файлы

**Удалить**:
- `packages/agent/packages/agent/src/rag/pipeline/index.ts`

**Создать**:
- `packages/agent/packages/agent/packages/agent/src/rag/pipeline/index.ts` — `RAGPipeline` class (≤200 LOC, whitelist). Конструктор + публичные методы `embedContent`, `indexEntry`, `search`, `getRerankCallsPerSearch` (если есть metric).
- `packages/agent/src/rag/pipeline/forgetting.ts` — Ebbinghaus-like forgetting curve / time-decay scoring (если есть в текущем файле).
- `packages/agent/src/rag/pipeline/boost-persona.ts` — persona-grade boost (+10% rerank weight для kind='persona').
- `packages/agent/src/rag/pipeline/boost-salience.ts` — salience boost (по confidence / age).
- `packages/agent/packages/agent/packages/agent/src/rag/pipeline/rrf.ts` — Reciprocal Rank Fusion для FTS + vec scores.
- `packages/agent/src/rag/pipeline/dedupe.ts` — dedup helpers (semantic + textual).
- `packages/agent/src/rag/pipeline/rerank-call.ts` — NVIDIA NIM rerank вызов + counter (`rerank_calls_per_search` metric).

**Создать**:
- `scripts/bench-rag.ts` — benchmarks 100 итераций `rag.search` с фиксированными query+candidates. Логирует p50/p95/p99 latency + `rerank_calls_per_search`. **Регрессия p95 ≤5%**, rerank_calls_per_search неизменно.

**Trigger**: `scripts/check-file-size.ts` row `"packages/agent/packages/agent/src/rag/pipeline/index.ts": 700` → удалить. Заменить на `"packages/agent/packages/agent/src/rag/pipeline/index.ts": 200` (CANONICAL_WHITELIST уже содержит).

## Изменение

1. `RAGPipeline` class в `index.ts` хранит deps (embed provider, rerank provider, db) + thin делегации.
2. Submodules — pure functions taking `{embed, rerank, db, candidates}` deps.
3. **CRITICAL**: rerank counter (`rerank_calls_per_search`) preserved + accessible.
4. Все consumers (`hippocampus.ts`, `extractors.ts`, `chat.service.ts`, MCP tools) — через `~/rag` или `~/rag/pipeline`.
5. Bench script — runs locally, results saved to `bench-results/rag-<sha>.json`. CI-проверка опциональна (script exit 1 если регрессия p95 >5%).

## Тесты

- `bun test tests/rag*.test.ts` — green.
- `bun run scripts/bench-rag.ts` (на main pre-split) — capture baseline → save to file.
- `bun run scripts/bench-rag.ts` (post-split) — compare to baseline. Pass если p95 regression ≤5%.
- `bun test` — без regression (838/0).

## Приёмка

1. `bun run scripts/check-file-size.ts` — `pipeline/index.ts` ≤200 (canonical), submodules ≤150, transitional `pipeline.ts:700` удалена.
2. `bun run scripts/check-deep-imports.ts` — green.
3. `bunx tsc --noEmit` — clean.
4. `bun test tests/repo-rules.test.ts` — 5/5.
5. `bun test` — 838/0 baseline.
6. `bun run scripts/bench-rag.ts` — p95 latency регрессия ≤5%; `rerank_calls_per_search` совпадает с baseline.

## Constraints

- Scope-lock: только файлы в §Файлы.
- Public API: `RAGPipeline` class methods unchanged.
- `rerank_calls_per_search` invariant preserved (никаких лишних rerank-вызовов).
- Никаких изменений в RRF / forgetting curve / persona boost формулах.
- Bench script сохранён в репо (`scripts/bench-rag.ts`), не gitignore'd.
