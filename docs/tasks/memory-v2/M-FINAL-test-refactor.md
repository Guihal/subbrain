# M-FINAL · Test + refactor pass after memory-v2 wave 1

**Tier:** P0 (закрывает wave) · **Effort:** M · **Deps:** M-01..M-07 merged · **Status:** OPEN

## Цель

Wave 1 memory-v2 (M-01 close MEM-2, M-02 access tracking, M-04 fts_log, M-07 kind/persona) был сделан за 4 PR'а с быстрой итерацией. Этот тикет — финальная инспекция и opportunistic refactor.

**Тест-пасс:** убедиться что 678/0 не ослабло, что нет flaky тестов, что live-end-to-end (если уместно — skip если не доступно) проходит, что typecheck строго чист, что нет `any`/`as` тёмных пятен.

**Рефактор-пасс:** опционально (если найдены проблемы) поправить:
- File-cap 250 LOC violations среди файлов которые росли в wave 1 (`src/db/schema.ts`, `src/rag/pipeline.ts`, `src/pipeline/agent-pipeline/post/validators.ts`, `src/db/tables/shared.ts`, `tests/memory-kind.test.ts` если >250).
- DRY-нарушения (M-01 критик отметил `writeSharedAtomic` в `src/mcp/tools/memory-tools.ts` дублирует `MemoryService.insertShared` — это интенциональное решение subagent'а; пересмотреть).
- Любые `any` / `as` casts появившиеся при wide-changes.
- Audit `docs/02-audit.md` — закрыть пункты которые wave 1 закрыл, открыть новые если выявлены.
- Проверить что `categoryToKind` зовётся при ВСЕХ путях писания shared (compressor, MCP tool, hippocampus). M-07 затронул только extractors.ts; compressor + MCP могут писать без kind → backfill default 'semantic' даже на persona-y контент.

## Файлы

Read-mostly (audit зона, скорее всего БЕЗ изменений):
- `src/db/schema.ts` (700+ LOC — exception per guardrails §1).
- `src/db/tables/shared.ts`, `src/db/tables/log.ts`, `src/db/tables/memory.ts`.
- `src/db/types.ts`.
- `src/repositories/memory.repo.ts`, `src/repositories/log.repo.ts`.
- `src/services/memory.service.ts`.
- `src/pipeline/agent-pipeline/post/{validators,extractors,hippocampus,gate,dedupe,extractors-helpers}.ts`.
- `src/pipeline/context-compressor.ts`.
- `src/mcp/tools/memory-tools.ts`, `src/mcp/registry/memory.tools.ts`.
- `src/rag/pipeline.ts`, `src/rag/types.ts`.
- `src/routes/memory.ts`.
- `web/app/composables/useMemory.ts`, `web/app/composables/useMemory/types.ts`, `web/app/pages/memory.vue`.
- All 4 wave plan files: `docs/tasks/memory-v2/{M-01,M-02,M-04,M-07}-*.md`.
- `docs/02-audit.md`.

Write-zone (только если есть проблемы):
- Любой файл из read-зоны где найдена issue.
- `docs/02-audit.md` — обязательно дописать секцию "Wave 1 memory-v2 review".
- `docs/tasks/memory-v2/M-FINAL-test-refactor.md` (этот файл) — `Status: DONE`.

**НЕ трогать:**
- Существующие миграции 1-12 — additive only, никаких schema rewrites.
- Тесты wave 1 (если они зелёные) — не "улучшать" то что работает.
- Конкретно `bumpAccess`, `searchLog`, `writeSharedAtomic` логику — это критик-одобренный код.

## Изменение

### 1. Test-пасс (обязательно)

Запустить:
- `bunx tsc --noEmit` → exit 0.
- `bun test` → ≥678 pass, 0 fail. Если есть flaky / regression — диагноз + фикс.
- `bun test --test-name-pattern "kind|access|fts_log|MEM-2|MEM-7|MEM-8|MEM-9"` → проверить что новые wave-1 тесты идут стабильно.
- `grep -rn "TODO M-0[1247]" src/ tests/` → не осталось ли temporary TODO'шек от субагентов.
- `grep -rn "(as any)\|@ts-ignore\|@ts-expect-error" src/ | grep -v "test"` — список (если что-то новое появилось).

### 2. Audit-пасс (обязательно — пишет новый раздел в audit.md)

Подсчитать LOC:
- `wc -l src/db/schema.ts src/rag/pipeline.ts src/pipeline/agent-pipeline/post/validators.ts src/db/tables/shared.ts tests/memory-kind.test.ts tests/fts-log.test.ts`.
- Files >250 (не из exception list `system-prompt.ts, model-map.ts, rag/pipeline.ts, MCP registry, telegram modules, tests`) → флагнуть.

Найти source-of-truth violations:
- `grep -rn "MemoryDB.*insertShared\|db\.insertShared" src/ scripts/` → должно быть 0 hits вне SEED_SKIP_EMBED branch.
- `grep -rn "categoryToKind" src/` → должно вызываться в extractors.ts, validators.ts. Если compressor / memory-tools.ts MCP path тоже пишут shared — они должны вызывать `categoryToKind` ИЛИ передавать explicit kind (TypeScript optional default 'semantic' acceptable если есть docstring почему).

### 3. Refactor-пасс (опционально — только если §1+§2 нашли проблемы)

Возможные refactor-моменты:
- Если `writeSharedAtomic` в `memory-tools.ts` действительно дублирует `MemoryService.insertShared` — поднять MemoryService в `MemoryTools` через DI, удалить дубль (как M-01 plan изначально просил).
- Если compressor's `compressorMemory()` shim в chat.service.ts можно упростить — упростить.
- Если `kind` в RAGResult должен пробрасываться через FtsResult/VecResult а не отдельным merge step'ом — починить.

Каждый refactor — небольшой commit с чётким "why".

### 4. Docs-пасс (обязательно)

В `docs/02-audit.md` добавить новую секцию:

```
### Memory-v2 wave 1 review (2026-04-26, M-FINAL)
**Closed:** MEM-2 (M-01), MEM-7 (M-02), MEM-8 (M-04), MEM-9 (M-07).
**Open follow-ups (не блокеры):**
- M-04.1: rolling N=10k embed for layer4_log.
- M-XX: <если найдены через audit-пасс>
**Tests:** 678 pass / 0 fail (650 baseline + 10 fts-log + 18 memory-kind).
**Migration counter:** 12 (next migration is 13).
**Anti-pattern observed:** parallel subagent leaked writes from worktree to main workdir (M-07). Future wave dispatches: enforce non-cd workflow in subagent prompts.
```

## Тесты

Для refactor'а — если что-то меняется, regression test обязателен (guardrails §10). Для pure audit-pass'а — никаких новых тестов.

## Приёмка (machine-checkable)

1. `bunx tsc --noEmit` → exit 0.
2. `bun test` → ≥678 pass, 0 fail.
3. `grep -rn "MemoryDB.*insertShared\|db\.insertShared" src/ scripts/ | grep -v SEED_SKIP_EMBED` → 0 hits либо все обоснованы.
4. Audit doc — есть секция "Memory-v2 wave 1 review".
5. M-FINAL plan file — Status: DONE.
6. Commit history — последний коммит на main = либо чистый docs-only audit-update, либо commit с conventional message и Co-Authored-By Claude.
7. Всё ещё единственный worktree (main), нет orphan branches.

## Риск + mitigations

- **False alarm на flaky тесте:** worktree env (web/node_modules) — известный false-positive. На main shouldn't trigger.
- **Опасность over-refactor:** строго anti-goal. Если §1+§2 ничего не нашли — закрыть тикет docs-only коммитом, не трогать код. "Если работает, не чини."
- **Concurrency in subagent:** этот тикет sequential (один subagent), не wave. Меньше шансов на повторение M-07 incident.

## Out of scope

- Реализация M-03, M-05, M-06, M-08 (это P1/P2 wave 2 — отдельные тикеты).
- Backfill `kind` для writers которые не вызывают `categoryToKind` (compressor, MCP) — если найдено, **зафиксировать как M-07.1** в audit, не править здесь.
- Любые changes в migrations 1-12.
- Performance tuning RAG retrieval — отдельная задача.

---

**Status:** OPEN
