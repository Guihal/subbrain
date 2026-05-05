# M-08 · Forgetting curve в retrieval ranking (MemoryBank-style)

**Tier:** P1 · **Effort:** M · **Deps:** M-02 (access) + M-03 (salience) — landed · **Status:** DONE (2026-04-26)
**Migration assignment:** **none** (pure RAG-side ranking — uses existing columns).

## Цель

MemoryBank (AAAI '24, arXiv 2305.10250) — Ebbinghaus-style forgetting curve: каждый memo имеет (timestamp, recall_count, importance) → retrieval-side `R = exp(-Δt / S)` где `S` = "memory strength" (растёт с recall_count + importance). После M-08: RAG rerank добавляет MemoryBank-style time-decay в финальный score, **без авто-удаления**.

Сейчас (после wave-1+2):
- M-02 даёт `last_accessed_at` + `access_count`.
- M-03 даёт `salience` + `last_decayed_at` + `bumpAccess` reinforce + night-cycle decay.
- M-07 даёт persona +10% boost.
- RAG rerank: `score *= (1 + 0.1*salience)` × persona×1.1.

После M-08:
- Final RAG ranking blend:
  ```
  R = exp(-Δt / S)
  S = 86400 * (1 + log(1 + access_count)) * (0.5 + salience)
  Δt = now - last_accessed_at  (если NULL → 0 → R=1.0)

  final_score = base_score
              * (1 + W_RECALL * R)         # MemoryBank recall — central new term
              * (1 + W_SALIENCE * salience) # M-03
              * persona_boost              # M-07 (1.1 if persona)
  ```
- Defaults: `W_RECALL = 0.15`, `W_SALIENCE = 0.1`. Tunable via env `RAG_RECALL_WEIGHT`, `RAG_SALIENCE_WEIGHT`.
- **Никаких auto-delete** — только ranking signal. Persona NEVER decays (override на R=1.0 для kind='persona' shared rows).
- Pure-fn `computeRecallScore(now, lastAccess, accessCount, salience): number` в `packages/core/packages/core/src/lib/memory-decay.ts` для тестируемости.

Foundation: M-08 — последний P1 ticket из roadmap'а wave-1/wave-2/wave-3. После него memory-v2 P1 закрыт (M-09/M-10/M-11/M-12 — P2 backlog).

## Файлы (scope-lock)

- `packages/core/packages/core/src/lib/memory-decay.ts` — **NEW** ≤80 LOC. Pure-fn `computeRecallScore` + `applyForgettingCurve(rows, now, weights): rows`. Без DB-зависимостей.
- `packages/agent/packages/agent/src/rag/pipeline/index.ts` — после `applySalienceBoost` (M-03) и `applyPersonaBoost` (M-07) — добавить `applyForgettingCurve` step. Order:
  1. base score (rerank или RRF).
  2. persona boost (M-07).
  3. salience boost (M-03).
  4. forgetting curve recall (M-08) ← новое.
  Re-sort после.
- `packages/agent/packages/agent/packages/agent/src/rag/types.ts` — расширить `RAGResult.last_accessed_at?: number | null`, `RAGResult.access_count?: number`, `RAGResult.salience?: number` (часть уже от M-03; нужно проверить).
- `packages/core/src/db/tables/{shared,memory}.ts` — если SELECT-list явный, добавить `last_accessed_at`, `access_count` в shared/context/archive helpers (от M-02 уже могло быть; проверить).
- `tests/memory-forgetting-curve.test.ts` — **NEW** ≤200 LOC. ≥8 кейсов.
- `docs/02-audit.md` — `### MEM-13 ✅ forgetting curve в retrieval (закрыто M-08)`.
- `docs/tasks/memory-v2/M-08-forgetting-curve.md` — Status DONE.

**НЕ трогать:**
- Миграции 1-14 — нужны существующие колонки только.
- M-03 decay step (night-cycle) — это persistence-side decay. M-08 это retrieval-side.
- Auto-delete — never. Только ranking penalty.
- Persona logic — M-07 logic untouched, M-08 добавляет override на decay для persona.
- Bump access (M-02) — ranking не меняет данные.

## Изменение

### `computeRecallScore` (pure)

```ts
export function computeRecallScore(
  nowSeconds: number,
  lastAccessSeconds: number | null,
  accessCount: number,
  salience: number,
): number {
  if (lastAccessSeconds === null) return 1.0; // never accessed → fresh proxy
  const dt = Math.max(0, nowSeconds - lastAccessSeconds); // seconds
  const dt_seconds_per_day = 86400;
  // S = strength in "characteristic days":
  const baseStrengthDays = 1 + Math.log(1 + accessCount);
  const salienceFactor = 0.5 + Math.max(0, Math.min(1, salience));
  const S = baseStrengthDays * salienceFactor; // days
  const tau = S * dt_seconds_per_day;
  return Math.exp(-dt / tau);
}
```

`tau` — характеристическое время затухания. С access_count=0, salience=0.5 → tau ≈ 1 day → R(1d)≈0.37, R(7d)≈0.0009. С access_count=10, salience=1.0 → tau ≈ 1+ln(11)*1.5 ≈ 4.6 days → R(7d)≈0.22.

### `applyForgettingCurve` shape

```ts
export function applyForgettingCurve(
  rows: RAGResult[],
  nowSeconds: number,
  weights: { recall: number; salience: number },
  options?: { skipPersona?: boolean }
): RAGResult[] {
  return rows.map(r => {
    if (options?.skipPersona && r.layer === 'shared' && r.kind === 'persona') {
      return r; // persona never decays
    }
    const R = computeRecallScore(
      nowSeconds,
      r.last_accessed_at ?? null,
      r.access_count ?? 0,
      r.salience ?? 0.5,
    );
    return { ...r, score: (r.score ?? 0) * (1 + weights.recall * R) };
  });
}
```

Default `skipPersona: true` — persona отключается decay через override.

### `RAGPipeline.search` integration

После rerank-or-fallback и после `applyPersonaBoost` + `applySalienceBoost`:

```ts
const W_RECALL = Number(process.env.RAG_RECALL_WEIGHT) || 0.15;
const W_SALIENCE = Number(process.env.RAG_SALIENCE_WEIGHT) || 0.1;
final = applyForgettingCurve(final, Math.floor(Date.now()/1000), { recall: W_RECALL, salience: W_SALIENCE });
final.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
```

(W_SALIENCE передаётся в форму но не используется в applyForgettingCurve — это документация; если нужно — переместить salience-boost в `applyForgettingCurve` тоже. Subagent волен выбрать архитектуру.)

### Persona override

`if (skipPersona && r.layer === 'shared' && r.kind === 'persona') return r unchanged`.

В тесте: insert persona row + access 30d ago → её R=1.0 (no decay) → ranking сохранён.

### `RAGResult` row shape

`last_accessed_at`, `access_count`, `salience`, `kind` — все optional. Помощник `hydrate*` (если есть) пробрасывает их из SELECTs. Verify M-02/M-03/M-07 уже вернули эти поля — extend если нет.

## Тесты

`tests/memory-forgetting-curve.test.ts`:

1. **`computeRecallScore` baseline** — `lastAccess=null` → 1.0. `dt=0` → 1.0.
2. **Decay over 1 day** — access_count=0, salience=0.5, dt=1day → R≈0.37 (e^-1).
3. **High access_count slows decay** — access_count=10, salience=0.5, dt=7d → R значительно > чем при access_count=0.
4. **High salience slows decay** — salience=1.0 vs 0.0 при равных остальных → salient row R выше.
5. **`applyForgettingCurve` updates score** — row с last_accessed_at=null → score *= (1 + 0.15*1.0) = 1.15.
6. **Old row penalty** — row 30d old + access_count=0 → R≈0 → score multiplier ≈ 1.0 (no penalty in score, не отрицательное).
7. **Persona override** — kind='persona' row 30d old → unchanged score (skipPersona=true).
8. **Re-sort respects new order** — 2 rows одинаковый base, A access 1h ago, B access 30d ago → A ranks higher после applyForgettingCurve.
9. **RAG end-to-end** — seed 3 shared rows (1 fresh, 1 30d old, 1 persona 30d old) → search возвращает order: persona ≈ fresh > old.
10. **`RAG_RECALL_WEIGHT=0` disables effect** — env-flag → final order = pre-forgetting order.

## Приёмка (machine-checkable)

1. `bunx tsc --noEmit` → exit 0.
2. `bun test tests/memory-forgetting-curve.test.ts` → all green.
3. `bun test` → ≥700 pass, 0 fail.
4. `grep -n "computeRecallScore\|applyForgettingCurve" packages/core/src/lib/memory-decay.ts packages/agent/packages/agent/src/rag/pipeline/index.ts` → ≥3 hits.
5. `grep -n "RAG_RECALL_WEIGHT\|skipPersona" packages/agent/packages/agent/src/rag/pipeline/index.ts packages/core/src/lib/memory-decay.ts` → ≥1 hit each.
6. `docs/tasks/memory-v2/M-08-forgetting-curve.md` Status: DONE.

## Out of scope

- Auto-delete по low-R. Never.
- Per-kind decay tuning (kind='episodic' faster than 'procedural'). M-08.1 follow-up.
- A/B бенчмарк (LongMemEval_S replication). Manual eval task.
- archive layer override (archive это compressed long-term — может decay медленнее). M-08.2.
- UI визуализация R per row. Out.

---

**Status:** DONE (2026-04-26).

## Implementation note (2026-04-26)

Plan §Persona override snippet `return r unchanged` was implemented as `R=1.0 pinned` instead — the no-bump branch let never-accessed semantic rows multiply by `1+W*1.0=1.15` while persona stayed at `×1`, flipping the M-07 invariant (`memory-kind.test.ts:308 "persona row outranks semantic row"`). Persona now passes through `R=1.0` and gets the same recall bump as equally-fresh semantic peers; the M-07 ×1.1 upstream persona boost preserves the rank gap.

Final tally: 711 pass / 0 fail / 92 files / 2107 expect calls. `bunx tsc --noEmit` exit 0.
