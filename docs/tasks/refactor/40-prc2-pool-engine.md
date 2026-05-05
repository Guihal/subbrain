# Задача 40 — PR-C2: Pool engine + free runner + done_with_artifact

**Оценка:** 6-8 часов (можно разбить на 2 итерации)
**Зависимости:** PR-C1 (задача 39)
**Status:** PENDING
**Spec ref:** [docs/superpowers/specs/2026-05-03-memory-hygiene-and-agent-usefulness.md § PR-C2 + done_with_artifact](../../superpowers/specs/2026-05-03-memory-hygiene-and-agent-usefulness.md)

## Цель

Single-runner pool engine. Заменяет старый `free-agent.ts`. Каждый pool-tick — одна задача типа `free` из `agent_tasks`, end-to-end, с обязательным артефактом или явным noop. После merge prod работает на одном runner type, free-agent legacy убран.

Бьёт R5 (curiosity loop без артефакта).

## Anti-economy reminder

В runner system-prompt'е **ЗАПРЕЩЕНО** писать «постарайся уложиться», «be efficient», «не используй tool без нужды», «save tokens». **РАЗРЕШЕНО** и **поощряется**: «используй tools агрессивно — embed/rerank/web/memory_search дешевле твоей нерешительности», «лучше 50 шагов с артефактом чем 5 noop». `maxSteps` — safety ceiling против infinite loops, не KPI.

## Контракт исполнителя

Эта задача — **scoped to single-runner free pool + done_with_artifact tool**. Никаких других runner типов, никакого parallel execution, никакого find-new-task. Если соблазн «ну добавлю и check-tg раз уж рядом» = scope creep = FAIL. PR-C3 это отдельная задача 41.

**Allowed actions:**
- Создать новые файлы из §Файлы → Новые модули (6 файлов).
- Edit `packages/server/src/app/bootstrap.ts`, `packages/agent/src/scheduler/free-agent.ts`, `.env.example` — только в местах указанных в §Изменения.
- Edit `packages/core/src/db/index.ts` ТОЛЬКО если нужно expose `agentTasksRepo` в `MemoryDB` для pool — но это сделано в PR-C1, проверь сначала через grep `agentTasksRepo` в `packages/core/src/db/index.ts`. Если уже есть — НЕ трогать файл.
- Edit `packages/agent/src/mcp/registry/index.ts` или аналог — wire-up `pool.tools.ts` registry. Минимальный edit.
- `bunx tsc --noEmit`, `bun test`, `bun run scripts/check-file-size.ts`.
- `git commit -m "feat(pool): single-runner agent pool + done_with_artifact (PR-C2)"`.

**Hard NO-GO:**
- НЕ создавать `clear.ts`, `check-tg.ts`, `research.ts`, `find-new-task.ts` runners — это PR-C3.
- НЕ менять `maxConcurrent` дефолт >1 — это PR-C4.
- НЕ удалять `packages/agent/src/scheduler/free-agent.ts` — только bridge mode (см. §Изменения).
- НЕ менять `AgentLoop.run` сигнатуру (`onUsage` callback должен УЖЕ существовать; если его нет — STOP, это отдельный pre-req PR).
- НЕ менять `agentMode: "scheduled"` semantics (`scheduled-blacklist.ts` / `telegram-spam-gate.ts`).
- НЕ переименовывать существующий `done` MCP tool. `done_with_artifact` — новый, рядом.
- НЕ trogать `docs/02-audit.md`, `docs/01-refactor-plan.md`, spec'ы в `docs/superpowers/specs/`.
- НЕ `git push`, НЕ `gh`, НЕ `--no-verify`.
- НЕ запускать prod migration / docker compose / ssh — deploy не часть задачи.
- В runner system-prompt'е НЕ писать «be efficient» / «save tokens» / «постарайся уложиться» (см. §Anti-economy).
- НЕ использовать `Promise.all` для fan-out — `Promise.allSettled`. НЕ использовать raw `fetch` — через `lib/http-client.ts`. НЕ использовать `as any`.

**Diff boundary:** ровно эти файлы (новые + modified):
```
.env.example
packages/server/src/app/bootstrap.ts
packages/agent/src/scheduler/free-agent.ts
packages/agent/src/scheduler/agent-pool/index.ts
packages/agent/src/scheduler/agent-pool/pool/index.ts
packages/agent/src/scheduler/agent-pool/runners/free.ts
packages/agent/src/scheduler/agent-pool/types.ts
packages/agent/src/mcp/registry/pool.tools.ts
packages/agent/src/mcp/registry/index.ts                 # минимальный wire-up
packages/agent/src/mcp/tools/pool/done-with-artifact.ts
tests/agent-pool-engine.test.ts
tests/done-with-artifact.test.ts
tests/agent-pool-runner-free.test.ts
```
Любой extra (включая `packages/core/src/db/**`) = STOP, FAIL.

**Output contract:** `OK <sha7> feat(pool): single-runner agent pool + done_with_artifact (PR-C2)` или `FAIL: <reason>`.

## Файлы

### Новые модули

- [packages/agent/src/scheduler/agent-pool/index.ts](../../../packages/agent/src/scheduler/agent-pool/index.ts) (≤100 lines) — orchestrator: `installAgentPoolScheduler({maxConcurrent:1, intervalMs})`. На каждом тике: zombie-recovery → claim → dispatch.
- [packages/agent/src/scheduler/agent-pool/pool/index.ts](../../../packages/agent/src/scheduler/agent-pool/pool/index.ts) (≤100 lines) — публичный фасад `AgentTaskPool` (вокруг repo): `claim`, `complete`, `noop`, `fail`, `enqueue`, `markZombiesFailed`. Без бизнес-логики, чистый thin wrapper.
- [packages/agent/src/scheduler/agent-pool/runners/free.ts](../../../packages/agent/src/scheduler/agent-pool/runners/free.ts) (≤150 lines) — `runFreeTask(task, ctx)`: запускает `AgentLoop.run({model:"teamlead", priority:"low", maxSteps, signal, agentMode:"scheduled"})` с system-prompt'ом из § runners/free.ts spec. Возвращает `{status:"complete", artifact}` или `{status:"noop", reason}` или `{status:"failed", reason}`.
- [packages/agent/src/scheduler/agent-pool/types.ts](../../../packages/agent/src/scheduler/agent-pool/types.ts) (≤80 lines) — `RunnerConfig`, `RunnerResult`, `PoolContext`.
- [packages/agent/src/mcp/registry/pool.tools.ts](../../../packages/agent/src/mcp/registry/pool.tools.ts) (≤120 lines) — registry entry для `done_with_artifact` tool (`scope: "agent-only"`).
- [packages/agent/src/mcp/tools/pool/done-with-artifact.ts](../../../packages/agent/src/mcp/tools/pool/done-with-artifact.ts) (≤80 lines) — handler логика. Возвращает результат — pool-runner мапит в `pool.complete`/`pool.noop`.

### Изменения

- [packages/server/src/app/bootstrap.ts](../../../packages/server/src/app/bootstrap.ts) — install pool scheduler если `AGENT_POOL_ENABLED=true`. Перед существующим free-agent блоком (free-agent legacy bridge ниже).
- [packages/agent/src/scheduler/free-agent.ts](../../../packages/agent/src/scheduler/free-agent.ts) — **legacy bridge mode** (НЕ удалять полностью):
  - Если `AGENT_POOL_ENABLED=true` И `FREE_AGENT=true` — на startup один раз `agentTasksRepo.enqueue({type:"free", prompt:<legacy prompt>, createdBy:"legacy-free-agent"})`. Лог `logger.warn("free-agent.legacy", "deprecated, enqueued one task; disable FREE_AGENT env")`.
  - Если `AGENT_POOL_ENABLED=false` — старое поведение без изменений (back-compat).
- [.env.example](../../../.env.example) — новый блок `# === agent-pool (spec 2026-05-03) ===`:
  ```
  AGENT_POOL_ENABLED=false
  AGENT_POOL_INTERVAL_MS=60000
  AGENT_POOL_MAX_CONCURRENT=1                 # PR-C2: single-runner; PR-C4 поднимет до 3
  AGENT_POOL_MAX_TOKENS_PER_TASK=60000        # safety rail (FM-6), не KPI
  AGENT_POOL_MAX_TOKENS_FREE=60000
  AGENT_POOL_MAX_TOKENS_FIND_NEW_TASK=10000
  ```

## Изменение

### 1. `done_with_artifact` tool (registry)

Schema:
```ts
input: t.Object({
  status: t.Union([t.Literal("complete"), t.Literal("noop")]),
  artifact: t.Optional(t.Object({
    type: t.String({minLength:1}),
    content: t.Unknown(),
    url: t.Optional(t.String())
  })),
  reason: t.Optional(t.String()),
}),
scope: "agent-only",
```

Handler validation:
- `status === "complete"` → `artifact` REQUIRED, иначе `ToolError{code:"validation_failed", message:"complete requires artifact"}`
- `status === "noop"` → `reason` REQUIRED (≥10 chars), иначе validation_failed
- Возвращает `ToolResult{ok:true, data:{terminate:true, status, artifact?, reason?}}`. AgentLoop ловит это (как old `done`) и terminates loop. Pool-runner парсит final result и мапит в `pool.complete()` / `pool.noop()`.

### 2. Pool scheduler tick

```ts
async function tick(deps: {pool, router, agentLoop, logger}): Promise<void> {
  // 1. zombie recovery
  const zombies = deps.pool.markZombiesFailed(Date.now()/1000 - 1800);
  if (zombies > 0) deps.logger.warn("pool.tick", "marked zombies", {count: zombies});

  // 2. router skip-tick на overload
  if (deps.router.isOverloaded()) {
    deps.logger.info("pool.tick", "router overloaded, skipping", {});
    return;
  }

  // 3. claim
  const task = deps.pool.claim();
  if (!task) return;  // empty pool — find-new-task в PR-C3

  // 4. dispatch
  const result = await runFreeTask(task, ctx);  // только free runner в PR-C2

  // 5. persist
  if (result.status === "complete") deps.pool.complete(task.id, result.artifact);
  else if (result.status === "noop") deps.pool.noop(task.id, result.reason);
  else deps.pool.fail(task.id, result.reason);
}
```

`installAgentPoolScheduler` устанавливает `setInterval(tick, AGENT_POOL_INTERVAL_MS)`. `intervalMs` floor 10s.

### 3. Free-runner system-prompt (system message)

Влепить в `runners/free.ts` как const:

```
Ты выполняешь pool-задачу type=free. Промпт пользовательской задачи ниже.

ACCEPTANCE: вызови `done_with_artifact` с status="complete" + artifact (объект {type, content, url?}) ИЛИ status="noop" + reason (строка ≥10 chars). Без этого вызова task → failed.

ANTI-ECONOMY: используй tools агрессивно. Лучше 50 шагов с артефактом чем 5 шагов "noop по неуверенности". `memory_search` перед `memory_write` — cheap insurance, делай всегда.

CONSULT: перед commit'ом любого non-trivial подхода — `consult_chaos` (что может пойти не так?). Перед architecturally-irreversible решением — `consult_specialists`. Quotas (5 chaos / 6 specialists) — safety rails, не budgets.

ANTI-IDLE: 3 read-only шага подряд → переключайся, у тебя есть write-tools.

SAFETY: payments / irreversible writes / cookies — запрещено. SMS/email/PR-submit — suggest через TG-confirm flow, не direct.

PRIORITY ORDER: D1 (создать code-tool со smoke-pass) > D3 (web-route ≥5 clicks с артефактом) > D4 (PR/issue draft) > D2 (research, ≤3 facts в shared/context). Research — fallback, не дефолт.

ЗАДАЧА:
{task.prompt}
```

### 4. Per-task token budget (FM-6 safety rail)

```ts
const MAX_TOKENS = Number(process.env.AGENT_POOL_MAX_TOKENS_FREE ?? process.env.AGENT_POOL_MAX_TOKENS_PER_TASK ?? 60000);
let consumed = 0;
const tokenAbort = new AbortController();

const result = await agentLoop.run({
  model: "teamlead",
  priority: "low",
  maxSteps: 50,
  agentMode: "scheduled",
  signal: tokenAbort.signal,
  systemMessage: SYSTEM,
  userMessage: task.prompt,
  onUsage: (u) => {
    consumed += u.total_tokens ?? 0;
    if (consumed > MAX_TOKENS) tokenAbort.abort(new Error("token_budget_exceeded"));
  },
});
```

Если `tokenAbort` сработал — task → failed с `reason="token_budget_exceeded"`. Telemetry: `logger.warn("pool.runner", "token_budget_exceeded", {task_id, type, consumed, cap})`.

### 5. Scheduled-mode tool gating

`agentMode: "scheduled"` already существует. Free runner allowed tools (через registry scope filter — НЕ ручной allowlist):
- `web_*`, `memory_*` (с PR-A validators), `embed_*`, `rag_*`, `consult_chaos`, `consult_specialists`, `create_code_tool`/`edit_code_tool` (validators из task 15), `done_with_artifact`.
- Forbidden: `tg_send_message` (D4 идёт через TG-confirm, не direct send).

Существующие mechanism: [packages/agent/src/pipeline/agent-loop/code-tools/scheduled-blacklist.ts](../../../packages/agent/src/pipeline/agent-loop/code-tools/scheduled-blacklist.ts) + [packages/agent/src/pipeline/agent-loop/code-tools/telegram-spam-gate.ts](../../../packages/agent/src/pipeline/agent-loop/code-tools/telegram-spam-gate.ts) уже включены при `agentMode==="scheduled"`. Не менять.

## Тесты

Новый `tests/agent-pool-engine.test.ts`:
- Mock pool + agentLoop. Tick claims task, dispatches, persists complete/noop/failed.
- Zombie task (started_at < now-1800) → markZombiesFailed на следующем тике.
- Router.isOverloaded → tick early-return, claim не вызван.
- Empty pool → tick early-return, нет dispatch.

Новый `tests/done-with-artifact.test.ts`:
- `status:"complete"` без artifact → validation error.
- `status:"noop"` без reason → validation error.
- `status:"complete"` + artifact → handler возвращает `terminate:true`, AgentLoop останавливается.
- Pool-runner мапит result в `pool.complete(id, artifact)`.

`tests/agent-pool-runner-free.test.ts` (mock LLM):
- Stubbed router возвращает tool_call `done_with_artifact{status:"complete", artifact:{type:"test", content:"ok"}}` → runner returns `{status:"complete", artifact}`.
- Stubbed timeout (60s loop) + token budget 100 → tokenAbort → `{status:"failed", reason:"token_budget_exceeded"}`.

## Premortem

| # | Симптом | Mitigation | Recovery |
|---|---------|-----------|----------|
| 1 | `AgentLoop.run` не имеет `onUsage` callback или `signal` параметра | Проверить ДО старта: `grep -n 'onUsage\|signal' packages/agent/src/pipeline/agent-loop/types.ts`. Если нет — STOP, это pre-req PR. | `FAIL: pre-req-missing: AgentLoop.run lacks onUsage/signal — needs separate PR before C2`. |
| 2 | `done_with_artifact` collides с existing `done` tool — agent loop ловит обе как terminate | В `agent-loop/tool-dispatch.ts` (или эквивалент): treat both as terminator, но `done_with_artifact` приоритет если оба вызваны. Spec: новый tool — addition, не replacement. | Если test показывает что `done` ломается — fix dispatch logic в isolated commit, ВНУТРИ этой задачи (пограничный edit, осторожно). |
| 3 | Token budget abort через `AbortController` оставляет partial DB state (chat row written, tool result orphan) | `AgentLoop.run` уже использует `signal` для abort cleanly — pipeline does not commit partial chat. Если test показывает orphan — bug в loop, не в pool. | Если orphan — task → failed с reason="token_budget_exceeded; orphan rows: <N>", parent escalates. |
| 4 | Pool tick fires до того как DB migration 17 применилась (boot race) | `installAgentPoolScheduler` вызывать ПОСЛЕ `MemoryDB` migrate (т.е. после `new MemoryDB(...)`). В `bootstrap.ts` сначала db, потом scheduler. | `db.agentTasksRepo` будет undefined → tick crash → log error. Recovery: рестарт. Не auto-retry, fix order. |
| 5 | Free-agent legacy bridge enqueue срабатывает на каждом restart → дубль задач в pool | Bridge должен enqueue **только один раз per process lifetime** (in-memory flag). Если pod restart 10 раз = 10 задач (acceptable пока FREE_AGENT не выключен). После `FREE_AGENT=false` — bridge не срабатывает. | Если в prod видны 100 legacy enqueue — disable `FREE_AGENT` сначала. |
| 6 | Runner system-prompt содержит «save tokens» / «be efficient» (anti-economy violation) | Pre-commit grep'нуть system-prompt const на запрещённые фразы (см. §Anti-economy). | `FAIL: anti-economy-violation: free.ts system-prompt contains "be efficient"`. Переписать. |
| 7 | `tg_send_message` доступен runner'у (а не должен в free) | Registry scope filter: pool runner не должен expose `tg_send_message` напрямую. В runner ctx `availableTools` — explicitly без `tg_send_message`. Test: stub agent loop пытается вызвать → ToolError unknown_tool. | Если test fail — fix tool filter в runner setup. |
| 8 | Zombie recovery cutoff (1800s = 30min) слишком агрессивный для long-running web-задач | Cap = `AGENT_POOL_ZOMBIE_CUTOFF_S` env, default 1800. Документировать в `.env.example`. | Если в prod long task убит как zombie — поднять cutoff до 3600. Не fix code. |
| 9 | `pool.claim()` возвращает task но `pool.complete` падает (DB locked) → task навсегда running | `pool.complete/noop/fail` обёрнуты в try/catch + retry 3x с 100ms backoff. После — log error + leave running (zombie recovery подберёт через 30 мин). | Acceptable behavior. Telemetry: `logger.error("pool.persist", "complete failed", {id, attempts:3})`. |

## Приёмка

```bash
cd /usr/projects/subbrain
bunx tsc --noEmit                                                              # expect: exit 0
bun run scripts/check-file-size.ts                                             # expect: pass
bun test tests/agent-pool-engine.test.ts 2>&1 | tail -3                        # expect: "X pass / 0 fail"
bun test tests/done-with-artifact.test.ts 2>&1 | tail -3                       # expect: "X pass / 0 fail"
bun test tests/agent-pool-runner-free.test.ts 2>&1 | tail -3                   # expect: "X pass / 0 fail"
bun test 2>&1 | tail -3                                                        # expect: regression ≤ baseline+0

# File caps
wc -l packages/agent/src/scheduler/agent-pool/index.ts                                        # expect: ≤100
wc -l packages/agent/src/scheduler/agent-pool/pool/index.ts                                   # expect: ≤100
wc -l packages/agent/src/scheduler/agent-pool/runners/free.ts                                 # expect: ≤150
wc -l packages/agent/src/scheduler/agent-pool/types.ts                                        # expect: ≤80
wc -l packages/agent/src/mcp/registry/pool.tools.ts                                           # expect: ≤120
wc -l packages/agent/src/mcp/tools/pool/done-with-artifact.ts                                 # expect: ≤80

# Wire-up evidence
grep -n 'AGENT_POOL_ENABLED' packages/server/src/app/bootstrap.ts                              # expect: ≥1 match
grep -n 'installAgentPoolScheduler' packages/server/src/app/bootstrap.ts                       # expect: ≥1 match
grep -n 'legacy-free-agent' packages/agent/src/scheduler/free-agent.ts                        # expect: ≥1 match
grep -nE 'AGENT_POOL_MAX_TOKENS' .env.example                                  # expect: ≥2 matches (FREE + per-task)
grep -n 'done_with_artifact' packages/agent/src/mcp/registry/pool.tools.ts                    # expect: ≥1 match

# Anti-economy guard
grep -niE 'save tokens|be efficient|постарайся уложиться|не используй tool без нужды' packages/agent/src/scheduler/agent-pool/runners/free.ts  # expect: 0 matches

# Subbrain guardrails
grep -nE 'as any' packages/agent/src/scheduler/agent-pool/ packages/agent/src/mcp/registry/pool.tools.ts packages/agent/src/mcp/tools/pool/ 2>/dev/null  # expect: 0
grep -nE 'Promise\.all\b' packages/agent/src/scheduler/agent-pool/                            # expect: 0 (only allSettled allowed)
grep -nE '\bfetch\(' packages/agent/src/scheduler/agent-pool/                                 # expect: 0 (use http-client)

# Logger contract — single-arg call = bug
grep -nE 'logger\.(info|warn|error|debug)\([^,)]+\)' packages/agent/src/scheduler/agent-pool/ # expect: 0

# Boundary: no scheduler peers leaked
grep -rnE 'agent-pool/runners/(clear|check-tg|research|find-new-task)' src/   # expect: 0 (PR-C3)
```

Manual smoke (опционально, после `bun run packages/server/src/index.ts` локально с `AGENT_POOL_ENABLED=true` + test DB):
1. `curl -X POST localhost:4000/v1/admin/agent-pool/enqueue -d '{"type":"free","prompt":"navigate example.com and capture title","createdBy":"smoke"}'` (если admin route есть; иначе через `bun -e` direct repo call).
2. Ждать tick (60s).
3. `sqlite3 data/test.db 'SELECT id, status, artifact, reason FROM agent_tasks ORDER BY id DESC LIMIT 1'` → expect `status='done'` + non-null artifact JSON.

## Definition of Done

1. ✅ `git status` clean.
2. ✅ `git log -1 --format=%s` → "feat(pool): single-runner agent pool + done_with_artifact (PR-C2)".
3. ✅ `git diff HEAD~1..HEAD --name-only | sort` ≤ 13 файлов из §Контракт. Если 13 — все expected; если меньше — каждый недостающий должен иметь обоснование (mostly OK если registry/index.ts уже имел нужное). Если больше — STOP.
4. ✅ Все commands из §Приёмка выдали expected output.
5. ✅ `AGENT_POOL_ENABLED=false` дефолт в `.env.example` (НЕ включаем в prod в этом PR).
6. ✅ Free runner system-prompt прошёл anti-economy grep (0 matches).

## Deploy

```bash
ssh root@109.120.187.244
cd /opt/subbrain
git pull
docker compose build && docker compose up -d
# verify scheduler не падает
docker compose logs -f | grep -i pool
```

Изначально `AGENT_POOL_ENABLED=false` в prod. Включаем явным редактированием `.env` после smoke.

## Известные ограничения

- Только `free` runner в этом PR. `clear`/`check-tg`/`research`/`find-new-task` — PR-C3 (задача 41).
- `maxConcurrent` фиксирован = 1 (sequential). Параллелизм — PR-C4 (задача 42).
- Type-quota balance (force ≥30% non-research) — PR-C4 (требует find-new-task из C3).
- TG digest (daily rollup, real-time alerts) — НЕ в этом PR. Сейчас только log entries. Digest — PR-C3 вместе с find-new-task.
- Legacy `free-agent.ts` НЕ удалён, только bridge'ed. Полное удаление — после 1 мес prod-успеха pool engine.

## Escape hatch

При FAIL — одна строка:

```
FAIL: <category>: <≤80-char specific reason>
```

Categories: `pre-req-missing` | `tsc-error` | `test-fail` | `file-cap` | `diff-boundary` | `anti-economy-violation` | `done-collision` | `boundary-leak` | `wire-up-missing` | `unknown`.

Примеры:
- `FAIL: pre-req-missing: AgentLoop.run lacks onUsage callback`
- `FAIL: anti-economy-violation: free.ts:42 contains "be efficient"`
- `FAIL: done-collision: existing 'done' tool breaks when 'done_with_artifact' added`
- `FAIL: boundary-leak: created runners/clear.ts (PR-C3 scope)`
- `FAIL: file-cap: free.ts is 168 lines, max 150`

Stop. Не push, не deploy, не enqueue real tasks. Parent reads, decides.
