# M-11 · Sleep-time focus block rewriter (layer1_focus)

**Tier:** P2 · **Effort:** M · **Deps:** M-06 (reflect / shared promotion) + M-07 (kind enum) + M-08 (forgetting curve) — landed · **Status:** DONE (M-11)
**Migration assignment:** **16** (`layer1_focus_shadow` mirror table).

## Цель

Letta / sleep-time compute: focus blocks (KV в layer1_focus, инжектятся в КАЖДЫЙ system prompt) сейчас **только** ручные writes (UI / hippocampus memory_write). После M-06 reflect мы поднимаем episodic→shared semantic, но focus сам не self-rewrite.

После M-11: night-cycle step `focus-rewrite.ts` берёт top-K shared/persona memos (по recall × salience) + current layer1_focus → LLM (`memory` role) синтезирует обновлённый value для каждого editable focus key (≤500 char per block), пишет в **shadow-таблицу** `layer1_focus_shadow`. Реальный layer1_focus НЕ переписывается — shadow позволяет руками смотреть diff неделями перед flip'ом.

Goal: focus auto-stays-current с глобальной памятью без ручного hand-edit'а каждой недели.

Foundation:
- Letta MemGPT pattern (sleep-time autonomous block rewrite).
- CoALA: focus = procedural directive layer; должен отражать current state of semantic/episodic.
- Shadow-write аналогично `vec_embeddings` initial backfill (M-04.1) — feature gates через env'а пока buy-in.

## Файлы (scope-lock)

- `packages/core/packages/core/packages/core/src/db/schema.ts` — Migration 16: `CREATE TABLE layer1_focus_shadow (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)`. NO triggers, NO FTS — shadow only mirror.
- `packages/core/src/db/tables/memory.ts` — добавить методы `getShadowFocus(key) / setShadowFocus(key, value) / getAllShadowFocus() / clearShadowFocus()`. Mirror existing focus API. `updateRow`-pattern не применяется (KV).
- `packages/core/src/repositories/memory.repo.ts` — pass-through для shadow API.
- `packages/agent/packages/agent/packages/agent/packages/agent/src/pipeline/night-cycle/steps/focus-rewrite.ts` — **NEW** ≤200 LOC. Step `runFocusRewrite(deps): Promise<FocusRewriteResult>` где `{ rewritten, skipped, errors }`.
- `packages/agent/packages/agent/packages/agent/packages/agent/src/pipeline/night-cycle/post-steps.ts` — wire `runFocusRewrite` ПОСЛЕ `pruneFocus` (prune первый, потом rewrite — иначе rewrite пишет в shadow, который потом prune не видит на real).
- `packages/agent/packages/agent/packages/agent/packages/agent/src/pipeline/night-cycle/types.ts` — `FocusRewriteResult` interface.
- `tests/night-cycle-focus-rewrite.test.ts` — **NEW** ≤300 LOC. ≥6 кейсов.
- `docs/02-audit.md` — `### MEM-19 ✅ sleep-time focus block rewrite (закрыто M-11)`.
- `docs/tasks/memory-v2/M-11-sleep-time-focus-rewrite.md` (этот) — Status DONE.

**НЕ трогать:**
- Migrations 1-15.
- Existing `pruneFocus` (M-11 — separate step, runs ПОСЛЕ prune).
- Real `layer1_focus` writes (system prompt инжекция продолжает читать real, не shadow).
- `system-prompt.ts` — readers не touch.
- M-06 reflect (shared промоушн — orthogonal).
- Public REST `/v1/memory/focus` — leave (writes идут в real, как раньше).

## Изменение

### Migration 16

```sql
CREATE TABLE IF NOT EXISTS layer1_focus_shadow (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
```

`PRAGMA user_version = 16` после INSERT.

### Step shape

```ts
export async function runFocusRewrite(deps): Promise<FocusRewriteResult> {
  const log = deps.log;
  if (process.env.NIGHT_CYCLE_FOCUS_REWRITE_ENABLED !== "true") {
    return { rewritten: 0, skipped: 0, errors: 0 };
  }
  // 1. Get editable focus keys (skip PROTECTED_FOCUS_KEYS — same set as pruneFocus).
  const all = deps.memory.getAllFocus();
  const editable = Object.entries(all).filter(([k]) => !PROTECTED_FOCUS_KEYS.has(k));
  if (editable.length === 0) return zero;

  // 2. Get top-K shared memos by recall × salience (CoALA: persona kind first).
  const topK = deps.memory.selectTopSharedForFocusRewrite(REWRITE_TOP_K);
  // {id, category, kind, content, salience, last_accessed_at, access_count}[]
  if (topK.length === 0) return zero;

  // 3. For each editable focus key — LLM rewrite synthesizing topK + current value.
  let rewritten = 0, skipped = 0, errors = 0;
  for (const [key, currentValue] of editable) {
    try {
      const newValue = await rewriteFocusBlock(deps.router, key, currentValue, topK);
      if (newValue && newValue !== currentValue && newValue.length <= MAX_FOCUS_LEN) {
        deps.memory.setShadowFocus(key, newValue);
        rewritten++;
        log.info(`focus-rewrite:shadow key=${key} len=${newValue.length}`);
      } else {
        skipped++;
      }
    } catch (err) {
      errors++;
      log.warn(`focus-rewrite: ${key} failed: ${(err as Error).message}`);
    }
  }
  log.info(`done: rewritten=${rewritten} skipped=${skipped} errors=${errors}`);
  return { rewritten, skipped, errors };
}
```

### `selectTopSharedForFocusRewrite`

Pure SQL helper в `db/tables/memory.ts` (raw SQL stays там per layer-boundary):

```sql
SELECT id, category, kind, content, salience, last_accessed_at, access_count
  FROM shared_memory
 WHERE status = 'active'
 ORDER BY (CASE WHEN kind='persona' THEN 1.5 ELSE 1.0 END)
        * (0.5 + COALESCE(salience, 0.5))
        * (1.0 + LOG(1 + COALESCE(access_count, 0)))
        DESC
 LIMIT ?
```

Не учитывает forgetting curve напрямую (нет lastAccess threshold) — берём top-K «по relevance»; декей применяется уже в RAG, а в focus-rewrite важна стабильная семантическая база.

Default `REWRITE_TOP_K = 30`. Env `FOCUS_REWRITE_TOP_K`.

### LLM prompt shape

```
SYSTEM: Ты обновляешь фокус-блок layer1_focus — короткое (≤500 chars) утверждение, инжектится в КАЖДЫЙ system prompt.
Получаешь:
- Текущий focus key + value.
- Top-K shared memos (most relevant facts о пользователе/проекте).

Цель: переписать value так, чтобы он СИНТЕЗИРОВАЛ актуальные shared facts, остался ≤500 chars, и НЕ потерял существующий контекст из value.

Если current value уже актуален / shared не добавляет нового — выводи EXACT current value (no-op signal).

Output: ТОЛЬКО новый value (no JSON, no fences). Никаких meta-комментариев.
```

User content: `key: ${key}\ncurrent: ${currentValue}\n\ntop_shared:\n${topK.map(t => `[${t.kind}] ${t.category}: ${t.content}`).join("\n")}`

`router.chat(NIGHT_CYCLE_MODEL, {messages, max_tokens: 600, temperature: 0.1}, "low")`. NIGHT_CYCLE_MODEL = `memory` role (default since 2026-04-25).

### Env knobs

- `NIGHT_CYCLE_FOCUS_REWRITE_ENABLED` (default `false`) — gate. Должен быть явно `=true` для активации.
- `FOCUS_REWRITE_TOP_K` (default 30).
- `FOCUS_REWRITE_MAX_LEN` (default 500).

### `MAX_FOCUS_LEN`

Hard guard 500 chars. Если LLM вернул >500 — skip (errors++). NO truncation (truncation теряет смысл; safer skip).

### `PROTECTED_FOCUS_KEYS`

Импорт из `prune/focus.ts` (или дублировать константу — но дублировать = code-smell; лучше exported из shared-helpers). Расширить export'ом если нужно.

### Read path

Real `layer1_focus` остаётся source of truth для `system-prompt.ts` (reader). Shadow читается ТОЛЬКО админ-UI и diff-tool'ом (out-of-scope — manual sql).

Future flip (out-of-scope в M-11): когда shadow обкатан weeks → копировать shadow → real в одном transaction-е, очищать shadow.

## Тесты

`tests/night-cycle-focus-rewrite.test.ts`:

1. **Disabled by default** — `NIGHT_CYCLE_FOCUS_REWRITE_ENABLED` unset → zeros.
2. **Empty focus → skipped** — no editable keys → zeros.
3. **No shared memos → zeros** — focus есть, shared empty → zeros (нечего синтезировать).
4. **Happy-path rewrite** — focus key + 5 shared persona memos → mock router возвращает новый value → shadow row written, rewritten=1.
5. **Real focus untouched** — happy-path (test 4) — assert `getFocus(key) === oldValue` (не trogano), `getShadowFocus(key) === newValue`.
6. **Protected keys skipped** — `night_cycle_last_processed_id` в editable filter — должен быть out (test seeds + expects).
7. **LLM identical output → skipped++** — mock router echoes current value → skipped=1 (no shadow write).
8. **LLM > MAX_FOCUS_LEN → skipped++** — mock returns 1000-char value → skipped=1.
9. **LLM throws → errors++** — mock throws → errors=1, step не падает.

Test DB = `data/test-mem11-focus-rewrite.db`.

## Приёмка (machine-checkable)

1. `bunx tsc --noEmit` → exit 0.
2. `bun test tests/night-cycle-focus-rewrite.test.ts` → all green.
3. `bun test` → ≥777 pass, 0 fail (770 baseline + ≥7 new).
4. `bun -e 'import {MemoryDB} from "./src/db"; const m=new MemoryDB("data/test-mfinal-mig16.db"); console.log(m.db.query("PRAGMA user_version").get()); m.close()'` → `{ user_version: 16 }`.
5. `grep -n "runFocusRewrite\|FOCUS_REWRITE\|layer1_focus_shadow" packages/agent/packages/agent/packages/agent/src/pipeline/night-cycle/steps/focus-rewrite.ts` → ≥3 hits.
6. `grep -n "layer1_focus_shadow" packages/core/packages/core/src/db/schema.ts packages/core/src/db/tables/memory.ts` → ≥3 hits (CREATE + методы).
7. M-11 plan file Status: DONE.
8. MEM-19 entry в `docs/02-audit.md`.

## Out of scope

- Shadow → real flip — out (manual SQL после weeks обкатки).
- Persona-only mode (только persona kind в top-K) — env-knob для будущего.
- Diff-tool / admin UI shadow viewer — out.
- Tuning TOP_K / MAX_FOCUS_LEN / scoring formula — A/B follow-up.
- Multi-iteration rewrite (rewrite shadow повторно из shadow) — out.

---

**Status:** DONE (M-11, mig 16)
