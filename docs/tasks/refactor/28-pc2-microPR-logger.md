# 28-P-C2 + MicroPR — close FILE-SIZE-1 + squeeze logger.ts

**Status:** OPEN. Master: [28-file-size-150-limit.md](28-file-size-150-limit.md) closing wave.

**Order:** AFTER all Wave 1-4 PRs merged.

## Цель

1. **MicroPR**: уменьшить `packages/core/packages/core/src/lib/logger.ts` 263 → ≤200 (canonical cap = 200, transitional cap = 263). Без split — squeeze multi-line statements + redundant patterns.
2. **P-C2**: закрыть FILE-SIZE-1 в audit (✅).

## Файлы

**MicroPR (logger.ts squeeze)**:
- Изменить: `packages/core/packages/core/src/lib/logger.ts` — uglify multi-line, объединить compact patterns. Целевой LOC ≤200.
- Изменить: `scripts/check-file-size.ts` — удалить TRANSITIONAL_WHITELIST row `"packages/core/src/lib/logger.ts": 263` (canonical 200 wins).

**P-C2 закрытие**:
- Изменить: `docs/02-audit.md` — FILE-SIZE-1 → ✅ CLOSED + дата.
- Изменить: `docs/01-refactor-plan.md` — strikethrough всех записей в Часть VIII (W1-1..W4-1, P0-A, P-C, P-C2, MicroPR).
- Изменить: `docs/tasks/refactor/28-file-size-150-limit.md` — `Status: DONE` + checkbox checks для всех PR.
- Изменить: `tests/repo-rules.test.ts` — удалить `SKIP_STRICT` env-flag (если оставался) + подтвердить, что STRICT с самого P-C по user override §F.4.

## Изменение

### MicroPR

1. Прочитать `packages/core/packages/core/src/lib/logger.ts` целиком.
2. Сжать без потери функциональности:
   - Multi-line `if (x) { return y; }` → `if (x) return y;`.
   - Multi-line ternary в console.log → 1-line или helper.
   - Удалить excess whitespace / blank lines между group'ами.
   - Combine type imports.
3. Verify: `wc -l packages/core/src/lib/logger.ts` ≤200.
4. Verify guardrails: logger contract `(stage, message, extra?)` арность сохранена; `child("subsystem")` factory сохранена; `formatForDb` сохранён.

### P-C2

1. `docs/02-audit.md`: найти `FILE-SIZE-1 OPEN` entry → заменить на `FILE-SIZE-1 ✅ CLOSED 2026-04-XX (master 28 done)`.
2. `docs/01-refactor-plan.md` Часть VIII: добавить strikethrough (`~~...~~`) каждой записи W1-1..W4-1.
3. `docs/tasks/refactor/28-file-size-150-limit.md`: `Status: DONE` + checkbox checks.
4. `tests/repo-rules.test.ts`: подтвердить отсутствие `SKIP_STRICT` (был ли когда-то) — если есть, удалить.

## Тесты

- `bun test tests/repo-rules.test.ts` — все 5 strict-зелёные.
- `bun run scripts/check-file-size.ts` — exit 0 (logger.ts ≤200, canonical wins).
- `bun run scripts/check-deep-imports.ts` — exit 0.
- `bun test` — 838/0 baseline.
- Manual smoke на dev-сервере: chat (stream + non-stream), /memory admin, autonomous agent 3 шага, night-cycle trigger, freelance leads page (если есть).

## Приёмка

1. `wc -l packages/core/src/lib/logger.ts` ≤ 200.
2. `scripts/check-file-size.ts` без `logger.ts:263` row.
3. `bun test tests/repo-rules.test.ts` — 5/5 STRICT.
4. `bun run scripts/check-file-size.ts` exit 0.
5. `bun run scripts/check-deep-imports.ts` exit 0.
6. `bunx tsc --noEmit` exit 0.
7. `bun test` ≥ baseline-passed (838/0), 0 failed.
8. Полный manual smoke без regress.
9. `docs/02-audit.md` FILE-SIZE-1 ✅.
10. `docs/01-refactor-plan.md` Часть VIII strikethrough.
11. `docs/tasks/refactor/28-file-size-150-limit.md` `Status: DONE`.

## Constraints

- Scope-lock: только файлы в §Файлы.
- Logger contract preserved: `logger.info(stage, message, extra?)` арность; single-arg call = bug.
- `child("subsystem")` + `formatForDb` API unchanged.
- Никаких функциональных изменений — только typographic squeeze.
