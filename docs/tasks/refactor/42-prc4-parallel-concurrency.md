# Задача 42 — PR-C4: parallel concurrency + per-type rate limits + type-quota enforcement

**Оценка:** 3-4 часа
**Зависимости:** PR-C3 (задача 41)
**Status:** PENDING
**Spec ref:** [docs/superpowers/specs/2026-05-03-memory-hygiene-and-agent-usefulness.md § PR-C4](../../superpowers/specs/2026-05-03-memory-hygiene-and-agent-usefulness.md)

## Цель

Pool на полной мощности — `maxConcurrent=3` параллельных runners. Per-type rate limits защищают от contention. Type-quota balance гарантирует ≥30% non-research за rolling 24h (FM-4 fix). Бьёт final piece из R5.

## Контракт исполнителя

Эта задача — **concurrency primitives + parallel tick + type-quota enforcement + claim-by-id race-safety**. НЕ создавать новые runner типы. НЕ менять system-prompt'ы runner'ов. НЕ trogать hippocampus / teamlead (PR-D/E).

**Allowed actions:**
- Создать `packages/agent/src/scheduler/agent-pool/pool/concurrency.ts` (≤100), `packages/agent/src/scheduler/agent-pool/pool/rate-limits.ts` (≤80).
- Edit `packages/agent/src/scheduler/agent-pool/index.ts` — расширить tick на parallel dispatch + Promise.allSettled.
- Edit `packages/agent/src/scheduler/agent-pool/pool/find-new.ts` — расширить distribution-skew enforcement (был информационный, стал блокирующий: `enqueueForcedNonResearch`).
- Edit `packages/core/src/db/tables/agent-tasks.ts` — добавить `peekNextPending()` + изменить `claim` на `claim(id)`. **Если** существующий `claimNext()` API нужен другим callers — **сохранить** его (deprecation) и добавить `claim(id)` рядом.
- Edit `packages/core/src/repositories/agent-tasks.repo.ts` — expose `peekNextPending()` + `claim(id)`.
- Edit `.env.example` — поднять `AGENT_POOL_MAX_CONCURRENT` дефолт до 3.
- `bunx tsc --noEmit`, `bun test`, `bun run scripts/check-file-size.ts`.
- `git commit -m "feat(pool): parallel concurrency + per-type rate limits + type-quota (PR-C4)"`.

**Hard NO-GO:**
- НЕ менять `agent_tasks` schema (нет миграции 18 — schema зафиксирована задачей 39 / migration_17).
- НЕ создавать новых runner'ов / новых типов task'ов.
- НЕ менять system-prompt'ы существующих runner'ов.
- НЕ trogать `done_with_artifact` / digest / `agent_tasks_enqueue` tool.
- НЕ менять `runners/free.ts`, `clear.ts`, `check-tg.ts`, `research.ts` (только find-new-task в `pool/find-new.ts` логика).
- НЕ заменять `Promise.allSettled` на `Promise.all` (guardrail §2).
- НЕ использовать raw `Mutex` impl — должен быть существующий `lib/mutex` (если нет — STOP, отдельный pre-req).
- НЕ менять `agentMode: "scheduled"` semantics.
- НЕ trogать `packages/agent/src/pipeline/`, `packages/agent/src/services/`, `packages/server/src/routes/` — strict scope.
- НЕ `git push`, НЕ `gh`, НЕ `--no-verify`.
- НЕ запускать prod / docker / ssh — deploy не часть задачи.

**Diff boundary:** ровно эти файлы:
```
.env.example
packages/core/src/db/tables/agent-tasks.ts
packages/core/src/repositories/agent-tasks.repo.ts
packages/agent/src/scheduler/agent-pool/index.ts
packages/agent/src/scheduler/agent-pool/pool/concurrency.ts
packages/agent/src/scheduler/agent-pool/pool/find-new.ts
packages/agent/src/scheduler/agent-pool/pool/rate-limits.ts
tests/agent-pool-concurrency.test.ts
tests/agent-pool-rate-limits.test.ts
tests/find-new-type-quota.test.ts
tests/agent-pool-claim-race.test.ts
```
Любой extra (особенно в `runners/`, `services/`, `pipeline/`) = STOP, FAIL.

**Output contract:** `OK <sha7> feat(pool): parallel concurrency + per-type rate limits + type-quota (PR-C4)` или `FAIL: <reason>`.

## Файлы

- [packages/agent/src/scheduler/agent-pool/index.ts](../../../packages/agent/src/scheduler/agent-pool/index.ts) — расширить tick: parallel dispatch до `AGENT_POOL_MAX_CONCURRENT`. `Promise.allSettled` для fan-out (НЕ `Promise.all` — guardrail §2).
- [packages/agent/src/scheduler/agent-pool/pool/concurrency.ts](../../../packages/agent/src/scheduler/agent-pool/pool/concurrency.ts) (≤100 lines) — новый: `RunnerSlots` — Mutex-guarded counter активных runner'ов per-type. `tryAcquire(type): boolean`, `release(type)`.
- [packages/agent/src/scheduler/agent-pool/pool/rate-limits.ts](../../../packages/agent/src/scheduler/agent-pool/pool/rate-limits.ts) (≤80 lines) — новый: per-type cooldowns (`check-tg`=5min, `clear`=max-1-parallel, `free`/`research`=без сверх-лимитов).
- [packages/agent/src/scheduler/agent-pool/pool/find-new.ts](../../../packages/agent/src/scheduler/agent-pool/pool/find-new.ts) — расширить distribution-skew enforcement (был информационный в C3, стал блокирующий: type-quota REJECT enqueue вместо `find-new-task` если skew нарушен).
- [.env.example](../../../.env.example) — `AGENT_POOL_MAX_CONCURRENT=3` (default — было 1 в C2).

## Изменение

### 1. Parallel tick

```ts
async function tick(deps: PoolContext): Promise<void> {
  // 1. zombie recovery (как раньше)
  deps.pool.markZombiesFailed(Date.now()/1000 - 1800);

  // 2. router skip-tick на overload
  if (deps.router.isOverloaded()) return;

  // 3. parallel claim до maxConcurrent
  const slots = deps.runnerSlots;
  const dispatched: Array<Promise<void>> = [];

  while (slots.totalActive() < deps.config.maxConcurrent) {
    const peek = deps.pool.peekNextPending();  // не claim — только peek
    if (!peek) break;

    // per-type rate limit
    if (!deps.rateLimits.allow(peek.type)) {
      // skip этого peek — вернёмся к нему позже
      break;  // (упрощение: не итерируем по pending'ам с rate-limited типом)
    }

    if (!slots.tryAcquire(peek.type)) break;

    const task = deps.pool.claim(peek.id);  // claim by id, atomic
    if (!task) {
      slots.release(peek.type);
      continue;  // race с другим runner'ом — try next
    }

    dispatched.push((async () => {
      try {
        const result = await dispatch(task, deps);
        if (result.status === "complete") deps.pool.complete(task.id, result.artifact);
        else if (result.status === "noop") deps.pool.noop(task.id, result.reason);
        else deps.pool.fail(task.id, result.reason);
      } finally {
        slots.release(task.type);
        deps.rateLimits.recordCompletion(task.type);
      }
    })());
  }

  if (dispatched.length === 0) return;
  await Promise.allSettled(dispatched);  // wait for all in this tick — НЕ Promise.all
}
```

**`peekNextPending()` + `claim(id)`** — новые методы repo. `peek` НЕ обновляет status, `claim(id)` атомарно `UPDATE ... WHERE id=? AND status='pending'` с проверкой affected-rows > 0 (защита от race между peek и claim).

### 2. `RunnerSlots` (concurrency.ts)

```ts
import { Mutex } from "../../../lib/mutex"; // existing

export class RunnerSlots {
  private active = new Map<AgentTaskType, number>();
  private mutex = new Mutex();
  private maxPerType: Partial<Record<AgentTaskType, number>>;
  // По спеку: clear=max 1, остальные unbounded под maxConcurrent.

  constructor(perType: Partial<Record<AgentTaskType, number>>) {
    this.maxPerType = perType;
  }

  async tryAcquire(type: AgentTaskType): Promise<boolean> {
    return this.mutex.run(async () => {
      const n = this.active.get(type) ?? 0;
      const cap = this.maxPerType[type];
      if (cap !== undefined && n >= cap) return false;
      this.active.set(type, n + 1);
      return true;
    });
  }

  release(type: AgentTaskType): void {
    this.mutex.run(() => {
      const n = this.active.get(type) ?? 0;
      if (n > 0) this.active.set(type, n - 1);
    });
  }

  totalActive(): number {
    let sum = 0;
    for (const n of this.active.values()) sum += n;
    return sum;
  }
}
```

Constructor wiring:
```ts
new RunnerSlots({
  clear: 1,           // DB-write contention
  // 'free', 'research', 'check-tg', 'find-new-task' — без per-type cap, бьёт totalActive
});
```

### 3. `RateLimits` (rate-limits.ts)

```ts
const COOLDOWNS_MS: Partial<Record<AgentTaskType, number>> = {
  "check-tg": 5 * 60 * 1000,
  // 'clear' — через RunnerSlots cap=1
  // остальные — без cooldown
};

export class RateLimits {
  private lastCompletion = new Map<AgentTaskType, number>();

  allow(type: AgentTaskType): boolean {
    const cd = COOLDOWNS_MS[type];
    if (!cd) return true;
    const last = this.lastCompletion.get(type) ?? 0;
    return Date.now() - last >= cd;
  }

  recordCompletion(type: AgentTaskType): void {
    this.lastCompletion.set(type, Date.now());
  }
}
```

### 4. Type-quota enforcement (find-new-task)

В [pool/find-new.ts](../../../packages/agent/src/scheduler/agent-pool/pool/find-new.ts) расширить логику:

```ts
const dist = repo.getDistributionSince(now - 86400);
const totalComplete = dist.filter(d => d.status === 'done').reduce((s,d)=>s+d.count,0);
if (totalComplete >= 5) {  // statistical noise floor
  const research = dist.find(d => d.type === 'research' && d.status === 'done')?.count ?? 0;
  if (research / totalComplete > 0.7) {
    // Принудительно: НЕ enqueue research; следующий enqueue ОБЯЗАТЕЛЬНО free (D1/D3) или check-tg.
    return enqueueForcedNonResearch(repo);
  }
}
```

`enqueueForcedNonResearch(repo)` — выбирает между D1 prompt template («создай простую code-tool которая делает X», варьирует X) и D3 prompt template («посети и сделай ≥5 кликов на сайте Y», варьирует Y).

### 5. Parallel-claim race-test

Добавить в `agent_tasks` table метод `claim(id: number, now: number): AgentTaskRecord | null`:

```sql
UPDATE agent_tasks
   SET status='running', started_at=?
 WHERE id=? AND status='pending'
RETURNING *;
```

`changes() === 0` → returns null (race lost). `RETURNING` гарантирует atomicity.

`peekNextPending()`:
```sql
SELECT * FROM agent_tasks
 WHERE status='pending'
   AND (scheduled_at IS NULL OR scheduled_at <= ?)
 ORDER BY priority DESC, scheduled_at, id
 LIMIT 1;
```

## Тесты

`tests/agent-pool-concurrency.test.ts`:
- `RunnerSlots`: parallel `tryAcquire("clear")` × 2 → один true, один false (cap=1).
- `RunnerSlots.totalActive()` правильно считает sum по всем types.
- 5 pending tasks (mix types) + maxConcurrent=3 → tick диспатчит ровно 3, остальные ждут next tick.

`tests/agent-pool-rate-limits.test.ts`:
- `check-tg` complete → next 5 min `allow("check-tg") === false`.
- Через 5 мин → `allow === true` снова.

`tests/find-new-type-quota.test.ts`:
- Stub distribution: research=8/done, free=2/done → `enqueueForcedNonResearch` triggered.
- research=4/done, free=6/done (=40%) → нормальный flow, free/D2 candidate возможен.
- totalComplete<5 → НЕ enforce (noise floor).

`tests/agent-pool-claim-race.test.ts`:
- Spawn 2 parallel `pool.claim(id)` для одного row → ровно один success, второй null. Repeat 50 раз — никаких гонок.

## Premortem

| # | Симптом | Mitigation | Recovery |
|---|---------|-----------|----------|
| 1 | `lib/mutex` не существует или другой API | `grep -rn 'class Mutex' src/lib/` ДО старта. Если нет — STOP, pre-req. | `FAIL: pre-req-missing: src/lib/mutex.ts not found, RunnerSlots needs it`. |
| 2 | `peekNextPending` + `claim(id)` race: между peek и claim другой process клейм'ит row | `claim(id)` атомарный `UPDATE...WHERE id=? AND status='pending' RETURNING *`. Если `changes()===0` → возвращает null. Test обязан spawn 50 concurrent claim'ов на один id и проверить ровно 1 success. | Если test fail → bug в SQL, не в JS. fix WHERE clause. |
| 3 | `RunnerSlots.tryAcquire` async vs sync — caller'ы могут ждать или не ждать | API: ВСЕ методы async (Mutex.run возвращает Promise). Test: `await slots.tryAcquire(...)` обязателен. | Если sync вариант где-то — fix call site, не изменить API. |
| 4 | `Promise.allSettled` дольше чем pool tick interval — тики накладываются | Re-entry guard: `tickRunning: boolean` флаг + early return если `tickRunning`. Уже есть в C2 (или должен быть — проверить). Если нет — добавить. | Если в логах видны overlapping ticks → fix re-entry guard. |
| 5 | `enqueueForcedNonResearch` использует static prompt template → зацикливается на одном содержании | Random выбор из ≥3 templates per category (D1, D3). Memoize last-N в memory чтобы не повторять. | Если в проде skew sustained на одном prompt → расширить templates pool. |
| 6 | `RateLimits.allow` использует in-memory state — pool restart забывает cooldown | Acceptable: на restart первый tick может нарушить cooldown. Не critical. Альтернатива: persist в `agent_tasks` через MAX(finished_at) query (slower). Default = in-memory. | Если в проде видны spam-rate-limit-violations after restart → переключить на DB-backed query. |
| 7 | Зомби recovery бьёт running task который ещё работает (overlap с 30-min cutoff и long task) | `AGENT_POOL_ZOMBIE_CUTOFF_S` env (PR-C2). Поднять до 3600 если у нас есть >30 мин runners (research, free/D3). | Acceptable: zombie marks failed, runner finishes и tries to write done — fail (row already failed) → log warn. Не data corruption. |
| 8 | `find-new.ts` distribution не учитывает `find-new-task` тип в знаменателе → ratio неправильный | `dist.filter(d => d.type !== 'find-new-task' && d.status === 'done')` обязательно. Test обязан проверить. | Если ratio bug → fix filter. |
| 9 | Tick диспатчит N задач сразу, все претендуют на ratelimit/slot — race в peek loop | `tryAcquire` атомарный per-call. Loop условие `slots.totalActive() < maxConcurrent` пересчитывается after each acquire. `break` если nothing dispatched (gradual fill OK). | Если test concurrency показывает >maxConcurrent active → fix loop logic. |
| 10 | `claim(id)` SQL `RETURNING *` НЕ supported в старом SQLite (<3.35) | Bun ships ≥3.45. Verify `sqlite3 --version`. Если CI runs older — fail-fast. | `FAIL: sqlite-version: needs ≥3.35 for RETURNING`. Не workaround. |
| 11 | Backwards-compat: existing callers `claimNext()` ломаются после rename → `claim(id)` | Сохранить `claimNext()` deprecated (return null + log warn) ИЛИ replace во всех call sites одним атомарным diff. Проверить grep `claimNext` в src/ ДО старта. | Если callers есть — обновить вместе с этим PR (in-scope). Если нет — `claimNext` можно удалить. |

## Приёмка

```bash
cd /usr/projects/subbrain
bunx tsc --noEmit                                                                    # expect: exit 0
bun run scripts/check-file-size.ts                                                   # expect: pass
bun test tests/agent-pool-concurrency.test.ts 2>&1 | tail -3                         # expect: "X pass / 0 fail"
bun test tests/agent-pool-rate-limits.test.ts 2>&1 | tail -3                         # expect: "X pass / 0 fail"
bun test tests/find-new-type-quota.test.ts 2>&1 | tail -3                            # expect: "X pass / 0 fail"
bun test tests/agent-pool-claim-race.test.ts 2>&1 | tail -3                          # expect: "X pass / 0 fail"
bun test 2>&1 | tail -3                                                              # expect: regression ≤ baseline+0

# File caps
wc -l packages/agent/src/scheduler/agent-pool/pool/concurrency.ts                                   # expect: ≤100
wc -l packages/agent/src/scheduler/agent-pool/pool/rate-limits.ts                                   # expect: ≤80
wc -l packages/agent/src/scheduler/agent-pool/index.ts                                              # expect: ≤100

# Promise.allSettled, не all
grep -cE 'Promise\.all\b' packages/agent/src/scheduler/agent-pool/index.ts                          # expect: 0
grep -cE 'Promise\.allSettled' packages/agent/src/scheduler/agent-pool/index.ts                     # expect: ≥1

# RunnerSlots cap config
grep -nE 'clear:\s*1' packages/agent/src/scheduler/agent-pool/index.ts                              # expect: ≥1 (RunnerSlots config wire-up)

# Type-quota logic correct
grep -nE "type !== 'find-new-task'" packages/agent/src/scheduler/agent-pool/pool/find-new.ts        # expect: ≥1 (denominator filter)
grep -nE 'enqueueForcedNonResearch' packages/agent/src/scheduler/agent-pool/pool/find-new.ts        # expect: ≥1

# claim-by-id atomic
grep -nE "WHERE id=\?\s+AND\s+status='pending'" packages/core/src/db/tables/agent-tasks.ts         # expect: ≥1
grep -nE 'RETURNING \*' packages/core/src/db/tables/agent-tasks.ts                                 # expect: ≥1

# .env default updated
grep -nE 'AGENT_POOL_MAX_CONCURRENT=3' .env.example                                  # expect: ≥1 match

# Subbrain guardrails
grep -rnE 'as any' packages/agent/src/scheduler/agent-pool/pool/                                    # expect: 0
grep -rnE '\bfetch\(' packages/agent/src/scheduler/agent-pool/pool/                                 # expect: 0
grep -rnE 'logger\.(info|warn|error|debug)\([^,)]+\)' packages/agent/src/scheduler/agent-pool/pool/ # expect: 0 (single-arg = bug)

# Concurrency stress test (50 race iterations)
bun test tests/agent-pool-claim-race.test.ts --test-name-pattern "50 parallel"       # expect: pass

# Backwards compat — old claimNext если был, не сломать
grep -rn 'claimNext' src/ tests/ 2>/dev/null                                         # если matches есть → они должны указывать на live code (not orphan), если orphan → удалить в этом PR
```

Manual smoke (опционально, локально):
1. enqueue 5 free-tasks → tick → одновременно 3 running, 2 pending. `sqlite3 data/test.db "SELECT id, status FROM agent_tasks ORDER BY id"` подтверждает.
2. Force skew: `bun -e 'for (let i=0;i<8;i++) db.agentTasksRepo.enqueue({type:"research",prompt:"x",createdBy:"smoke"}); ...'` → дать им complete'нуться → next find-new-task → enqueue type ∈ {free, clear, check-tg}, не research.
3. `check-tg` complete → mock 30s wait → `rateLimits.allow("check-tg")` → false. Wait 5 min → true.

## Definition of Done

1. ✅ `git status` clean.
2. ✅ `git log -1 --format=%s` → "feat(pool): parallel concurrency + per-type rate limits + type-quota (PR-C4)".
3. ✅ `git diff HEAD~1..HEAD --name-only | sort` ≤ 11 файлов из §Контракт.
4. ✅ Все commands из §Приёмка выдали expected output.
5. ✅ `claim-race` test stable across 3 consecutive runs (no flakes).
6. ✅ `bunx tsc --noEmit` clean.
7. ✅ `bun test` regression ≤ baseline.

## Deploy

```bash
ssh root@109.120.187.244
cd /opt/subbrain
git pull
docker compose build && docker compose up -d
docker compose logs -f | grep -E '(pool\.tick|pool\.runner|pool\.dispatch)'
```

В prod: `AGENT_POOL_MAX_CONCURRENT=3`. Если RPM 429 errors начнут появляться → откат до `=2` через env hot-reload.

## Известные ограничения

- `maxConcurrent` дефолт = 3 калиброван под NVIDIA NIM free-tier 40 RPM. Если provider rotation поменяет — пересмотреть.
- `clear` runner per-type cap=1 — DB-write contention. Если нужно больше parallel cleanup → batch (одна задача чистит N (layer,category) пар) вместо повышения cap.
- Type-quota threshold (>70% research) — heuristic. После 7-day prod run пересмотреть; возможно 60% или 80%.
- Chaos-driven tasks (D1 / D3 prompts в `enqueueForcedNonResearch`) — статичные templates. Future: LLM-generated через `find-new-task` runner с creative prompt.

## Escape hatch

При FAIL — одна строка:

```
FAIL: <category>: <≤80-char specific reason>
```

Categories: `pre-req-missing` | `tsc-error` | `test-fail` | `file-cap` | `diff-boundary` | `claim-race` | `quota-bug` | `promise-all-violation` | `sqlite-version` | `mutex-missing` | `boundary-leak` | `unknown`.

Примеры:
- `FAIL: pre-req-missing: src/lib/mutex.ts not found`
- `FAIL: claim-race: 50-iter test shows 2 winners on same id`
- `FAIL: promise-all-violation: index.ts:88 uses Promise.all (must be allSettled)`
- `FAIL: quota-bug: find-new.ts denominator includes find-new-task`
- `FAIL: boundary-leak: edited runners/free.ts (PR-C2 territory)`

Stop. Не push, не deploy. Parent reads, decides.
