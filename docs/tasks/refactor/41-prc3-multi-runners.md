# Задача 41 — PR-C3: clear / check-tg / research / find-new-task runners + TG digest

**Оценка:** 6-8 часов
**Зависимости:** PR-C2 (задача 40)
**Status:** PENDING
**Spec ref:** [docs/superpowers/specs/2026-05-03-memory-hygiene-and-agent-usefulness.md § PR-C runners + digest](../../superpowers/specs/2026-05-03-memory-hygiene-and-agent-usefulness.md)

## Цель

Pool диверсифицирован — 5 типов runner'ов. `find-new-task` пополняет pool автоматически. TG digest (daily rollup + real-time alerts) заменяет per-task TG spam. Sequential (max 1 параллельно) — параллелизм PR-C4.

## Anti-economy reminder

В каждом runner-prompt'е запрещены экономящие фразы. Поощряется агрессивное использование tools. См. [docs/superpowers/specs/...md § "NO TOKEN ECONOMY"](../../superpowers/specs/2026-05-03-memory-hygiene-and-agent-usefulness.md).

## Контракт исполнителя

Эта задача — **4 новых runner'а + find-new-task логика + digest + расширение switch'а**. НЕ trogать parallel concurrency / RunnerSlots / Mutex (PR-C4 = задача 42). НЕ трогать hippocampus prompt (PR-D = задача 43). НЕ трогать teamlead synthesis (PR-E = задача 44).

**Allowed actions:**
- Создать 7 новых файлов (runners 4 + pool/find-new.ts + digest.ts + tg/handler).
- Edit `packages/agent/src/scheduler/agent-pool/index.ts` — расширить tick на switch + auto-enqueue find-new-task + daily rollup cron.
- Edit `.env.example` — добавить ровно перечисленные env vars.
- Edit `packages/agent/src/mcp/registry/index.ts` (или эквивалент) для регистрации `agent_tasks_enqueue` tool (agent-only scope).
- Создать `packages/agent/src/mcp/tools/pool/agent-tasks-enqueue.ts` (≤80 lines) — handler для нового tool.
- `bunx tsc --noEmit`, `bun test`, `bun run scripts/check-file-size.ts`.
- `git commit -m "feat(pool): clear/check-tg/research/find-new-task runners + digest (PR-C3)"`.

**Hard NO-GO:**
- НЕ менять `agent_tasks` schema (нет миграции 18+ — schema из задачи 39 фиксирована до PR-D далёких релизов).
- НЕ менять `runners/free.ts` (PR-C2).
- НЕ менять `done_with_artifact` schema/handler (PR-C2).
- НЕ менять `maxConcurrent` дефолт (PR-C4).
- НЕ менять `agentMode: "scheduled"` semantics.
- НЕ удалять `packages/agent/src/scheduler/free-agent.ts` (PR-C2 bridge остаётся).
- НЕ trogать `packages/agent/src/pipeline/agent-pipeline/post/**` (PR-D).
- НЕ trogать `packages/agent/src/pipeline/arbitration/prompts.ts` (PR-E).
- НЕ создавать `tg_send_message` calls в clear/check-tg/research runners (forbidden tools).
- НЕ обходить registry scope filter — все forbidden tools отрезает scope, а не runtime if.
- НЕ `git push`, НЕ `gh`, НЕ `--no-verify`.
- НЕ trogать `docs/02-audit.md`, `docs/01-refactor-plan.md`, spec'ы.
- НЕ запускать prod / docker / ssh — deploy не часть задачи.
- В runner system-prompt'ах НЕ писать «save tokens» / «be efficient» / «постарайся уложиться» (anti-economy).

**Diff boundary:** ровно эти файлы (новые + modified):
```
.env.example
packages/agent/src/scheduler/agent-pool/index.ts
packages/agent/src/scheduler/agent-pool/runners/clear.ts
packages/agent/src/scheduler/agent-pool/runners/check-tg.ts
packages/agent/src/scheduler/agent-pool/runners/research.ts
packages/agent/src/scheduler/agent-pool/runners/find-new-task.ts
packages/agent/src/scheduler/agent-pool/pool/find-new.ts
packages/agent/src/scheduler/agent-pool/digest.ts
packages/agent/src/telegram/bot/handlers/digest-mode.ts
packages/agent/src/mcp/registry/index.ts                       # минимальный wire-up agent_tasks_enqueue
packages/agent/src/mcp/tools/pool/agent-tasks-enqueue.ts
tests/agent-pool-runners.test.ts
tests/find-new-task-logic.test.ts
tests/digest-format.test.ts
tests/check-tg-runner.test.ts
```
Любой extra (в т.ч. в `packages/core/src/db/`, `packages/agent/src/services/`, `packages/agent/src/pipeline/`) = STOP, FAIL.

**Output contract:** `OK <sha7> feat(pool): clear/check-tg/research/find-new-task runners + digest (PR-C3)` или `FAIL: <reason>`.

## Файлы

### Новые runners

- [packages/agent/src/scheduler/agent-pool/runners/clear.ts](../../../packages/agent/src/scheduler/agent-pool/runners/clear.ts) (≤120 lines) — memory cleanup, одна (layer, category) пара за тик.
- [packages/agent/src/scheduler/agent-pool/runners/check-tg.ts](../../../packages/agent/src/scheduler/agent-pool/runners/check-tg.ts) (≤120 lines) — read-only TG monitoring (auto-detect `last_message_ts > now-1d`, blocklist via `CHECK_TG_EXCLUDE`).
- [packages/agent/src/scheduler/agent-pool/runners/research.ts](../../../packages/agent/src/scheduler/agent-pool/runners/research.ts) (≤120 lines) — focused research, ≤3 supersede-aware shared facts артефакт.
- [packages/agent/src/scheduler/agent-pool/runners/find-new-task.ts](../../../packages/agent/src/scheduler/agent-pool/runners/find-new-task.ts) (≤120 lines) — meta-runner, enqueue 1-3 новых tasks.
- [packages/agent/src/scheduler/agent-pool/pool/find-new.ts](../../../packages/agent/src/scheduler/agent-pool/pool/find-new.ts) (≤120 lines) — pure logic для find-new-task: distribution skew check, dedup-search, enqueue helpers (используется runner'ом). Single responsibility — не путать с runner-обёрткой.

### Digest

- [packages/agent/src/scheduler/agent-pool/digest.ts](../../../packages/agent/src/scheduler/agent-pool/digest.ts) (≤100 lines) — `composeDailyRollup(tasks)`, `composeInstantAlert(task)`, switch по `digest_mode`.
- [packages/agent/src/telegram/bot/handlers/digest-mode.ts](../../../packages/agent/src/telegram/bot/handlers/digest-mode.ts) (≤80 lines) — handler команды `/digest_mode quiet|verbose`, single `setFocus("digest_mode", value)` call.

### Изменения

- [packages/agent/src/scheduler/agent-pool/index.ts](../../../packages/agent/src/scheduler/agent-pool/index.ts) — расширить tick: dispatch по `task.type` через switch на 5 runner'ов; на empty pool + 10-min cooldown → enqueue `find-new-task`; daily rollup cron в 21:00 local.
- [packages/agent/src/scheduler/agent-pool/runners/free.ts](../../../packages/agent/src/scheduler/agent-pool/runners/free.ts) — без изменений (PR-C2).
- [.env.example](../../../.env.example) — добавить блок:
  ```
  AGENT_POOL_MAX_TOKENS_RESEARCH=80000
  AGENT_POOL_MAX_TOKENS_CHECK_TG=20000
  AGENT_POOL_MAX_TOKENS_CLEAR=15000
  AGENT_POOL_DIGEST_HOUR_LOCAL=21
  CHECK_TG_EXCLUDE=                          # csv chat IDs to skip; empty = read all active
  CHECK_TG_KEYWORDS=                          # csv keywords for real-time alert
  ```

## Изменение

### 1. `clear` runner

System prompt:
```
Ты выполняешь pool-задачу type=clear (memory hygiene). Пользовательский промпт укажет (layer, category) пару для чистки.

ACCEPTANCE: вызови `done_with_artifact` со status="complete" + artifact={type:"cleanup", removed: N, archived: M, layer, category} ИЛИ status="noop" + reason если нечего чистить.

ANTI-ECONOMY: используй memory_search агрессивно для нахождения дубликатов / просрочек / низкокачественных rows. Это инкремент к night-janitor (PR-B), не замена.

GRANULARITY: одна задача = одна (layer, category) пара. Не лезь в другие.

TOOLS: memory_search, memory_archive (если есть) или batch memory_write {layer:"archive"} с reference back, done_with_artifact.

FORBIDDEN: memory_delete без --confirm, web_*, tg_send_message.
```

Allowed tools (через registry scope filter): `memory_search`, `memory_write` (только в archive), `done_with_artifact`. Forbidden — explicit reject в `runners/clear.ts` через filter перед dispatching.

### 2. `check-tg` runner

Auto-detect chats:
```ts
const exclude = new Set((process.env.CHECK_TG_EXCLUDE ?? "").split(",").map(s=>s.trim()).filter(Boolean));
const allChats = await tg.list_chats();
const active = allChats.filter(c => c.last_message_ts > Date.now()/1000 - 86400 && !exclude.has(String(c.chat_id)));
```

System prompt:
```
Ты выполняешь pool-задачу type=check-tg (READ-ONLY мониторинг TG inbox).

ACCEPTANCE: artifact={type:"tg_check", chats_checked:[...], unread_summary: "≤500 chars" или ""}. Если нет ничего важного → artifact с пустым unread_summary, status="complete" (не noop).

TOOLS: tg_list_chats, tg_read_chat, memory_write (для значимых сообщений в context layer), done_with_artifact.

FORBIDDEN: tg_send_message — НИКОГДА не отвечай. Это read-only.
```

Per-type rate-limit (на pool-tick перед claim): `check-tg` — max 1 раз в 5 мин. Реализация — query `MAX(finished_at) FROM agent_tasks WHERE type='check-tg'`, skip-if-recent.

Real-time alert keywords (для digest): если `unread_summary` содержит keyword из `CHECK_TG_KEYWORDS` (csv) → `composeInstantAlert(task)` instead of daily rollup.

### 3. `research` runner

System prompt:
```
Ты выполняешь pool-задачу type=research. Промпт укажет topic.

ACCEPTANCE: artifact={type:"research", facts:[{layer, category, content}], summary} с 1-3 facts. Если ничего значимого не нашёл → noop с reason.

ANTI-ECONOMY: web_search + rerank — дешевле чем неуверенность. consult_chaos обязателен ≥1 раз перед commit'ом подхода.

WRITES: memory_write supersede-aware (cosine pre-check через memory_search; если ≥0.92 — supersedes_id, не дубль).

TOOLS: web_*, memory_search, memory_write (≤3, shared/context), embed_*, rerank_*, consult_*, done_with_artifact.

FORBIDDEN: create_code_tool, tg_send_message.
```

Token budget: `AGENT_POOL_MAX_TOKENS_RESEARCH=80000` (default).

### 4. `find-new-task` (meta-runner)

Триггеры:
- `claim()` returns null AND `MAX(finished_at) FROM agent_tasks WHERE type='find-new-task' < now() - 600` (10-min cooldown).
- Pool tick автоматически enqueue'ит `find-new-task` в pending когда оба условия выполнены.

Логика в `pool/find-new.ts`:
1. `getDistributionSince(now-86400)` — rolling 24h distribution.
2. **Type-quota check** (FM-4 fix): если `research` > 70% complete-tasks → next enqueue **должен** быть `free` (D1 или D3 prompt). Принудительно.
3. **Dedup search**: для каждого candidate prompt → `memory_search` + `agent_tasks WHERE prompt LIKE %snippet% AND created_at > now()-86400`. Skip если match.
4. Enqueue 1-3 task'ов с `createdBy:"find-new-task"`.

System prompt для runner-обёртки:
```
Ты выполняешь meta-задачу type=find-new-task. Цель: пополнить пустой pool 1-3 новыми задачами.

ACCEPTANCE: artifact={type:"enqueued", count: N, types: [...]}. Если ничего не нашёл что enqueue — noop с reason="no candidates".

ANTI-ECONOMY: memory_search через recent activity, layer1_focus, open backlogs. Лучше найти 3 интересных задачи чем 0 безопасных.

TYPE BALANCE: за rolling 24h ≥30% complete-tasks должны быть type ≠ research. Если skew → принудительно free (D1 code-tool / D3 web-route) или check-tg.

TOOLS: memory_search, agent_tasks repo (enqueue only), done_with_artifact.
```

Allowed tools: filter restrict до `memory_search`, `done_with_artifact` + новый internal tool `agent_tasks_enqueue` (registry, agent-only scope) — обёртка над `agentTasksRepo.enqueue`.

### 5. TG digest

#### Daily rollup (21:00 local)

`installAgentPoolScheduler` дополнительно регистрирует cron на 21:00 (env `AGENT_POOL_DIGEST_HOUR_LOCAL`):

```ts
async function dailyRollupTick(deps): Promise<void> {
  const since = Date.now()/1000 - 86400;
  const tasks = deps.agentTasksRepo.getCompletedSince(since);
  const text = composeDailyRollup(tasks);
  await deps.telegramBot.notify(getDigestChatId(), text);
}
```

Format:
```
🤖 Agent pool — 2026-05-04 daily rollup
24h: 14 complete · 3 noop · 1 failed

Top artefacts:
✅ free#142 — D1 code-tool `weather_check_kazan`, smoke pass (12:34)
✅ free#149 — D3 web-flow scraped fl.ru briefs to /vault/research/freelance-2026-05-04.md (15:02)
✅ research#155 — 3 facts → shared (architecture, preference) (18:11)

By type: free=5, research=4, clear=3, check-tg=2, find-new-task=4
Failed: clear#152 — token_budget_exceeded (60k cap, see logs)
```

#### Real-time alerts (только для):
- `failed` (любой тип) — instant.
- `complete` для `free`/D3 (web-route ≥5 clicks) или `free`/D4 (PR/issue submitted) — определяется по `artifact.type === "web_route" && artifact.steps >= 5` или `artifact.type === "pr_draft"`.
- `complete` для `check-tg` если `artifact.unread_summary` содержит keyword из `CHECK_TG_KEYWORDS`.

Все остальные `complete` (research, clear, free/D1, free/D2, find-new-task) — НЕ instant, в daily rollup.

#### `/digest_mode` команда

`memoryService.setFocus("digest_mode", "quiet"|"verbose")`. Default `quiet` если ключ отсутствует. `verbose` mode → instant per-task TG message (back-compat старого free-agent).

### 6. Pool tick switch (расширение из C2)

```ts
async function dispatch(task: AgentTaskRecord, ctx: PoolContext): Promise<RunnerResult> {
  switch (task.type) {
    case "free":           return runFreeTask(task, ctx);
    case "clear":          return runClearTask(task, ctx);
    case "check-tg":       return runCheckTgTask(task, ctx);
    case "research":       return runResearchTask(task, ctx);
    case "find-new-task":  return runFindNewTask(task, ctx);
  }
}
```

Token budgets per type через `AGENT_POOL_MAX_TOKENS_<TYPE>` env.

## Тесты

`tests/agent-pool-runners.test.ts` (mock LLM, unit per runner):
- `runClearTask` — stub возвращает done_with_artifact{type:"cleanup", removed:N, archived:M} → runner returns proper artifact.
- `runCheckTgTask` — stub list_chats + read_chat → artifact с chats_checked + unread_summary.
- `runResearchTask` — stub web_search + memory_write × 2 → artifact.facts.length === 2.
- `runFindNewTask` — stub memory_search + 2 × enqueue → artifact.count === 2.

`tests/find-new-task-logic.test.ts`:
- Distribution с research=80% → next enqueue type ∈ {free, check-tg, clear}.
- Existing pending с похожим prompt → skip (dedup).
- 10-min cooldown — `MAX(finished_at) > now-600` → NO enqueue.

`tests/digest-format.test.ts`:
- `composeDailyRollup([...])` → строка содержит counts + top-3 artefacts + by-type.
- `composeInstantAlert(failedTask)` → строка с reason.
- `digest_mode=verbose` + complete task → `composeInstantAlert` triggered.

`tests/check-tg-runner.test.ts`:
- `CHECK_TG_EXCLUDE=123,456` → list_chats minus exclude.
- Per-type rate-limit: 2 consecutive ticks → second skip с "rate_limited" log.

## Premortem

| # | Симптом | Mitigation | Recovery |
|---|---------|-----------|----------|
| 1 | `tg_send_message` вызывается из `check-tg` runner (нарушение READ-ONLY) | Registry scope filter: clear/check-tg/research НЕ получают `tg_send_message` в `availableTools`. Test stub: попытка вызова → `ToolError{code:"unknown_tool"}`. | `FAIL: forbidden-tool: check-tg runner has tg_send_message in scope` — fix scope config, не runtime. |
| 2 | `agent_tasks_enqueue` доступен runner'ам кроме `find-new-task` | Tool scope = agent-only И в runner ctx тулы фильтруются по `task.type === "find-new-task"`. Test: free-runner вызов → ToolError. | Если другой runner пробрасывает — fix filter, добавить test-case. |
| 3 | `find-new-task` зацикливается: enqueue'ит больше задач чем complete'ится → pending растёт неограниченно | Hard cap: `find-new-task` max 1 active в pool (`listPending().filter(t=>t.type==="find-new-task").length === 0` гарантирует). + per-call cap 1-3 enqueue. | Если pending растёт — `bun -e 'db.agentTasksRepo.markZombiesFailed(0)'` не поможет (это не zombie). Manual `DELETE FROM agent_tasks WHERE status='pending' AND type='find-new-task'`. |
| 4 | Type-quota check проваливается — distribution рассчитан неправильно (24h cutoff, NULL handling) | `getDistributionSince(cutoff)` тестирован в PR-C1. Ratio: `research_count / (research+free+clear+check-tg)`, исключая `find-new-task` из знаменателя. NULL → 0. | Если в проде skew sustained → tighten threshold с 70% до 60% через `RESEARCH_QUOTA_MAX` env. Не code-change. |
| 5 | Daily rollup cron firing при `AGENT_POOL_ENABLED=false` (orphan timer) | Регистрировать cron ВНУТРИ `installAgentPoolScheduler` body, gated by `AGENT_POOL_ENABLED`. | Если firing видно при disabled — bug в bootstrap.ts wire-up, fix order. |
| 6 | `composeDailyRollup` падает на пустом массиве tasks (≥0 complete) | Edge-case test: `composeDailyRollup([])` → возвращает строку "🤖 Agent pool — <date>: no activity 24h". TG notify только если строка non-trivial. | N/A (handled). |
| 7 | `digest_mode` хранится в `layer1_focus` под ключом "digest_mode"; collision с user-set focus | Reserved key. Document в spec. `setFocus("digest_mode", v)` не должен conflict'ить. | Если юзер случайно `delete digest_mode` через UI — default fallback на "quiet". |
| 8 | TG digest бот upload в неправильный chat (нет `getDigestChatId`) | `getDigestChatId()` reads `OWNER_TG_CHAT_ID` env (already used). Если не set — log warn + skip notify. | `FAIL: missing-env: OWNER_TG_CHAT_ID required for digest`. |
| 9 | `check-tg` per-type rate-limit `MAX(finished_at)` query slow на больших таблицах | Index `idx_agent_tasks_distribution` (PR-C1) включает (type, status, finished_at) — query попадает. EXPLAIN QUERY PLAN покажет index use. | Если slow в проде → run `ANALYZE`. Не code-change. |
| 10 | `runFindNewTask` не находит candidates → noop каждый pool tick → infinite empty cycle | Floor: после 3 consecutive noop из find-new-task за 30 min → log warn + bump cooldown до 30 мин. | Acceptable behavior — empty pool лучше чем бессмысленные задачи. Telemetry alert. |
| 11 | Anti-economy violation в одном из 4 system-prompt'ов | Pre-commit grep на 4 файла. | `FAIL: anti-economy-violation: <file>:<line> contains "<phrase>"`. |
| 12 | `CHECK_TG_KEYWORDS` пустой → instant alerts никогда не fire'ят | Это feature (юзер опт-ин). Документировать в `.env.example` как пример: `CHECK_TG_KEYWORDS=urgent,срочно,deadline,crisis`. | N/A. |

## Приёмка

```bash
cd /usr/projects/subbrain
bunx tsc --noEmit                                                                            # expect: exit 0
bun run scripts/check-file-size.ts                                                           # expect: pass
bun test tests/agent-pool-runners.test.ts 2>&1 | tail -3                                     # expect: "X pass / 0 fail"
bun test tests/find-new-task-logic.test.ts 2>&1 | tail -3                                    # expect: "X pass / 0 fail"
bun test tests/digest-format.test.ts 2>&1 | tail -3                                          # expect: "X pass / 0 fail"
bun test tests/check-tg-runner.test.ts 2>&1 | tail -3                                        # expect: "X pass / 0 fail"
bun test 2>&1 | tail -3                                                                      # expect: regression ≤ baseline+0

# File caps (≤120 для runners, ≤100/80 для пр.)
for f in clear check-tg research find-new-task; do echo -n "$f: "; wc -l < packages/agent/src/scheduler/agent-pool/runners/$f.ts; done  # expect: каждый ≤120
wc -l packages/agent/src/scheduler/agent-pool/pool/find-new.ts                                              # expect: ≤120
wc -l packages/agent/src/scheduler/agent-pool/digest.ts                                                     # expect: ≤100
wc -l packages/agent/src/telegram/bot/handlers/digest-mode.ts                                               # expect: ≤80
wc -l packages/agent/src/mcp/tools/pool/agent-tasks-enqueue.ts                                              # expect: ≤80
wc -l packages/agent/src/scheduler/agent-pool/index.ts                                                      # expect: ≤100 (orchestrator cap)

# Anti-economy guard — все 4 runner system-prompt'a
for f in clear check-tg research find-new-task; do
  count=$(grep -ciE 'save tokens|be efficient|постарайся уложиться|не используй tool без нужды' packages/agent/src/scheduler/agent-pool/runners/$f.ts)
  echo "$f: $count violations"
done                                                                                         # expect: каждый "0 violations"

# Type-quota logic
grep -nE 'RESEARCH_QUOTA|>\s*0\.7|research.*ratio|TYPE BALANCE' packages/agent/src/scheduler/agent-pool/pool/find-new.ts  # expect: ≥1 match

# Switch dispatch covers all 5 types
grep -E 'case "(free|clear|check-tg|research|find-new-task)":' packages/agent/src/scheduler/agent-pool/index.ts | wc -l  # expect: 5

# Forbidden tool scope
grep -n 'tg_send_message' packages/agent/src/scheduler/agent-pool/runners/check-tg.ts                       # expect: 0 matches in availableTools list (только в forbidden comment OK)
grep -nE 'agent_tasks_enqueue' packages/agent/src/scheduler/agent-pool/runners/find-new-task.ts             # expect: ≥1 match (allowed)
grep -nE 'agent_tasks_enqueue' packages/agent/src/scheduler/agent-pool/runners/{clear,check-tg,research,free}.ts  # expect: 0

# .env.example documentation
grep -nE 'AGENT_POOL_MAX_TOKENS_(RESEARCH|CHECK_TG|CLEAR)' .env.example                      # expect: 3 matches
grep -nE 'CHECK_TG_(EXCLUDE|KEYWORDS)' .env.example                                          # expect: 2 matches
grep -nE 'AGENT_POOL_DIGEST_HOUR_LOCAL' .env.example                                         # expect: ≥1 match

# Subbrain guardrails
grep -rnE 'as any' packages/agent/src/scheduler/agent-pool/runners/ packages/agent/src/scheduler/agent-pool/pool/find-new.ts packages/agent/src/scheduler/agent-pool/digest.ts  # expect: 0
grep -rnE 'Promise\.all\b' packages/agent/src/scheduler/agent-pool/                                         # expect: 0
grep -rnE '\bfetch\(' packages/agent/src/scheduler/agent-pool/                                              # expect: 0
grep -rnE 'logger\.(info|warn|error|debug)\([^,)]+\)' packages/agent/src/scheduler/agent-pool/runners/      # expect: 0 (single-arg = bug)
```

Manual smoke (опционально, локально):
1. `enqueue({type:"clear", prompt:"clean shared/preference older than 90d"})` → tick → row status='done' artifact.removed/archived присутствуют.
2. Empty pool + wait 10 min (или mock cooldown) → auto-enqueue + dispatch find-new-task → 1-3 pending добавлены.
3. `/digest_mode verbose` → следующий complete → instant TG message.
4. `/digest_mode quiet` → 21:00 local → daily rollup TG message с counts/top-3/by-type.

## Definition of Done

1. ✅ `git status` clean.
2. ✅ `git log -1 --format=%s` → "feat(pool): clear/check-tg/research/find-new-task runners + digest (PR-C3)".
3. ✅ `git diff HEAD~1..HEAD --name-only | sort` ≤ 15 файлов из §Контракт.
4. ✅ Все commands из §Приёмка дали expected output.
5. ✅ Все 4 runner system-prompt'a прошли anti-economy grep (0 violations каждый).
6. ✅ `bunx tsc --noEmit` clean.
7. ✅ `bun test` regression ≤ baseline.

## Deploy

```bash
ssh root@109.120.187.244
cd /opt/subbrain
git pull
docker compose build && docker compose up -d
docker compose logs -f | grep -i pool
```

В prod: `AGENT_POOL_ENABLED=true`, `FREE_AGENT=false` (legacy off), `CHECK_TG_EXCLUDE` сконфигурировать (юзер задаёт).

## Известные ограничения

- `maxConcurrent` всё ещё = 1. Параллелизм + per-type rate-limit выше — PR-C4 (задача 42).
- Type-quota balance в `find-new-task` работает, но без параллельных runners ≥30%-non-research цель достижима только через temporal распределение.
- D4 (PR/issue submission) — agent готовит artefakt → enqueues `check-tg`-style confirm-task → юзер reply YES → отдельный manual run submits. НЕ direct в этом PR.
- `agent_tasks_enqueue` MCP tool — agent-only scope. Используется ТОЛЬКО `find-new-task` runner'ом. Если другой runner попытается — `ToolError{code:"forbidden"}`.

## Escape hatch

При FAIL — одна строка:

```
FAIL: <category>: <≤80-char specific reason>
```

Categories: `tsc-error` | `test-fail` | `file-cap` | `diff-boundary` | `anti-economy-violation` | `forbidden-tool` | `quota-logic-bug` | `digest-format` | `boundary-leak` | `wire-up-missing` | `unknown`.

Примеры:
- `FAIL: forbidden-tool: research.ts allows create_code_tool (forbidden by spec)`
- `FAIL: anti-economy-violation: research.ts:31 contains "be efficient"`
- `FAIL: quota-logic-bug: find-new.ts ratio includes find-new-task in denominator`
- `FAIL: digest-format: composeDailyRollup throws on empty array`
- `FAIL: boundary-leak: edited packages/core/src/db/schema.ts (PR-C1 territory)`

Stop. Не push, не deploy, не enqueue real tasks в prod. Parent reads, decides.
