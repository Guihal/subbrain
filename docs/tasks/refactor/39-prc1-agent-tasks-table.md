# Задача 39 — PR-C1: agent_tasks table + repo

**Оценка:** 2-3 часа
**Зависимости:** PR-B merged на main (задача 38)
**Status:** PENDING
**Spec ref:** [docs/superpowers/specs/2026-05-03-memory-hygiene-and-agent-usefulness.md § PR-C1](../../superpowers/specs/2026-05-03-memory-hygiene-and-agent-usefulness.md)

## Контекст schema-state (важно для миграции)

`packages/core/src/db/schema.ts` уже содержит миграции до `PRAGMA user_version = 16` (последняя — telegram chats schema). PR-A не добавлял миграций (только tighten validators), так что после merge PR-B следующий свободный номер — **17**. Pre-check ниже обязан подтвердить это перед стартом.

## Цель

Создать таблицу `agent_tasks` + repo-layer. После merge таблица существует, никто в неё ещё не пишет — фундамент для PR-C2 pool engine.

Бьёт R5 (free-agent goal "be curious" non-falsifiable) на schema-уровне: каждый pool-tick = одна явная типизированная задача с артефактом или явным noop.

## Pre-check (BLOCKING — выполнить перед любым кодом)

```bash
cd /usr/projects/subbrain
# 1. Текущая версия schema = 16 (жёстко). Если уже >16 — кто-то занял номер.
bun -e 'import {MemoryDB} from "./src/db"; const db=new MemoryDB(":memory:"); console.log(db.db.query("PRAGMA user_version").get())'
# expect: { user_version: 16 }
# Если 17 → STOP, FAIL: migration-conflict (кто-то уже создал миграцию 17).

# 2. PR-B merged
git log -1 --format='%s' main | grep -qE 'merge\(PR-B\)' && echo "PR-B ok" || echo "PR-B MISSING"
# expect: "PR-B ok". Если "PR-B MISSING" — STOP, задача 38 ещё не сделана.
```

Если оба check'а пройдены — proceed.

## Контракт исполнителя

Эта задача — **только schema + data layer + repo facade + tests**. НИКАКОЙ интеграции с pool / scheduler / runners. Любая попытка «заодно подключить» = scope creep = FAIL.

**Allowed actions** (только эти):
- Создать новые файлы: `packages/core/src/db/tables/agent-tasks.ts`, `packages/core/src/repositories/agent-tasks.repo.ts`, `packages/core/src/db/tables/agent-tasks/types.ts`, `tests/agent-tasks-repo.test.ts`, `tests/migration-17.test.ts`.
- Edit `packages/core/src/db/schema.ts` — добавить `migration_17_agent_tasks` в migrations array (после migration_16), **не трогать** существующие migration функции.
- Edit `packages/core/src/db/index.ts` — добавить `agentTasksRepo` поле + конструктор wire-up. **НЕ менять** другие repo / public API.
- `bunx tsc --noEmit`, `bun test`, `bun run scripts/check-file-size.ts`.
- `git add` ТОЛЬКО перечисленных файлов. `git commit -m "feat(db): add agent_tasks table + repo (PR-C1)"`.

**Hard NO-GO:**
- НЕ редактировать `packages/agent/src/scheduler/free-agent.ts`, `packages/agent/src/pipeline/**`, `packages/agent/src/mcp/**`, `packages/agent/src/services/**` — это PR-C2/C3.
- НЕ создавать `done_with_artifact` MCP tool, runner-engine, pool — это PR-C2.
- НЕ переименовывать существующие таблицы / migrations / индексы.
- НЕ менять `PRAGMA user_version` если уже ≥17 (конфликт миграций — STOP, см. §Pre-check).
- НЕ запускать миграцию на prod (`docker compose exec ... migrate`) — deploy не часть задачи.
- НЕ `git push`, НЕ `gh pr create`, НЕ `--no-verify`.
- НЕ использовать `as any`, raw `fetch`, `Promise.all` (см. `subbrain-guardrails`).

**Diff boundary:** `git diff --name-only HEAD~1..HEAD` после commit MUST содержать ровно эти файлы (5 new + 2 modified):
```
packages/core/src/db/index.ts
packages/core/src/db/schema.ts
packages/core/src/db/tables/agent-tasks.ts
packages/core/src/db/tables/agent-tasks/types.ts
packages/core/src/repositories/agent-tasks.repo.ts
tests/agent-tasks-repo.test.ts
tests/migration-17.test.ts
```
Любой extra файл = STOP, FAIL.

**Output contract:** `OK <sha7> feat(db): add agent_tasks table + repo (PR-C1)` или одна строка `FAIL: <reason>`.

## Файлы

- [packages/core/src/db/schema.ts](../../../packages/core/src/db/schema.ts) — migration entry: `migration_17_agent_tasks` (idempotent, после `migration_16`).
- Новый [packages/core/src/db/tables/agent-tasks.ts](../../../packages/core/src/db/tables/agent-tasks.ts) (≤150 lines) — raw SQL + row→entity mapping. Только этот модуль ходит в SQL по `agent_tasks` и `idx_agent_tasks_pending`.
- Новый [packages/core/src/repositories/agent-tasks.repo.ts](../../../packages/core/src/repositories/agent-tasks.repo.ts) (≤150 lines) — `AgentTasksRepository` фасад: `claim`, `listPending`, `getRunningOlderThan`, `complete`, `noop`, `fail`, `enqueue`, `markZombiesFailed`, `getDistribution24h`.
- Новый [packages/core/src/db/tables/agent-tasks/types.ts](../../../packages/core/src/db/tables/agent-tasks/types.ts) (≤80 lines) — `AgentTaskRecord`, `AgentTaskStatus`, `AgentTaskType`, `EnqueueInput`.
- [packages/core/src/db/index.ts](../../../packages/core/src/db/index.ts) — wire `AgentTasksRepository` instance в `MemoryDB` (поле `agentTasksRepo`).

## Изменение

### 1. Migration 17 (в `db/schema.ts`)

```sql
CREATE TABLE agent_tasks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  type         TEXT NOT NULL CHECK(type IN ('free','clear','check-tg','research','find-new-task')),
  prompt       TEXT NOT NULL,
  status       TEXT NOT NULL CHECK(status IN ('pending','running','done','noop','failed')) DEFAULT 'pending',
  priority     INTEGER NOT NULL DEFAULT 0,
  scheduled_at INTEGER,
  started_at   INTEGER,
  finished_at  INTEGER,
  artifact     TEXT,           -- JSON
  reason       TEXT,
  created_by   TEXT NOT NULL,  -- 'find-new-task'|'user'|'cron'|'self-recurse'|'legacy-free-agent'
  created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX idx_agent_tasks_pending
  ON agent_tasks(priority DESC, scheduled_at, id)
  WHERE status='pending';

CREATE INDEX idx_agent_tasks_running ON agent_tasks(status, started_at)
  WHERE status='running';

CREATE INDEX idx_agent_tasks_distribution
  ON agent_tasks(type, status, finished_at)
  WHERE status IN ('done','noop','failed');

PRAGMA user_version = 17;
```

В `db.transaction()`. Per-statement `.run()`. Idempotency guard: `if (currentVersion < 17) { ... }` (см. как сделаны migration_10..16 в `schema.ts`). Все existing tests должны pass без изменений (новая таблица не пересекается).

### 2. `db/tables/agent-tasks/types.ts`

```ts
export type AgentTaskType = 'free' | 'clear' | 'check-tg' | 'research' | 'find-new-task';
export type AgentTaskStatus = 'pending' | 'running' | 'done' | 'noop' | 'failed';

export interface AgentTaskArtifact {
  type: string;
  content: unknown;
  url?: string;
}

export interface AgentTaskRecord {
  id: number;
  type: AgentTaskType;
  prompt: string;
  status: AgentTaskStatus;
  priority: number;
  scheduledAt: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  artifact: AgentTaskArtifact | null;
  reason: string | null;
  createdBy: string;
  createdAt: number;
}

export interface EnqueueInput {
  type: AgentTaskType;
  prompt: string;
  priority?: number;
  scheduledAt?: number;
  createdBy: string;
}

export interface DistributionRow {
  type: AgentTaskType;
  status: AgentTaskStatus;
  count: number;
}
```

### 3. `db/tables/agent-tasks.ts`

Чистый data layer. Сигнатура (skeleton):

```ts
export class AgentTasksTable {
  constructor(private db: Database) {}

  insertPending(input: EnqueueInput): number  // returns rowid
  claimNext(now: number): AgentTaskRecord | null  // atomic UPDATE...RETURNING
  listPending(limit: number): AgentTaskRecord[]
  getRunningOlderThan(cutoff: number): AgentTaskRecord[]
  markRunning(id: number, now: number): void
  markComplete(id: number, artifact: AgentTaskArtifact, now: number): void
  markNoop(id: number, reason: string, now: number): void
  markFailed(id: number, reason: string, now: number): void
  markZombiesFailed(cutoff: number): number  // returns count
  getDistributionSince(cutoff: number): DistributionRow[]
  countByPromptSnippet(snippet: string, cutoff: number): number  // for find-new-task dedup
  getById(id: number): AgentTaskRecord | null
}
```

`claimNext` ATOMIC:
```sql
UPDATE agent_tasks
   SET status='running', started_at=?
 WHERE id = (
   SELECT id FROM agent_tasks
    WHERE status='pending'
      AND (scheduled_at IS NULL OR scheduled_at <= ?)
    ORDER BY priority DESC, scheduled_at, id
    LIMIT 1
 )
RETURNING *;
```

Row mapping: `JSON.parse(row.artifact)` если non-null; numeric/text 1:1.

### 4. `repositories/agent-tasks.repo.ts`

Фасад над `AgentTasksTable`. Без бизнес-логики, без других repo / service вызовов. Метрики (counters) — в PR-C2.

### 5. Wire в `db/index.ts`

```ts
this.agentTasksRepo = new AgentTasksRepository(new AgentTasksTable(this.db));
```

Публичный getter `db.agentTasksRepo`.

## Тесты

Новый `tests/agent-tasks-repo.test.ts`:

- `enqueue` + `listPending` → row виден.
- `claimNext` атомарность: 2 параллельных claim возвращают разные id (или один null).
- `claimNext` уважает `scheduledAt > now` — пропускает.
- `markComplete` / `markNoop` / `markFailed` обновляют status + finishedAt.
- `markZombiesFailed(now-1800)` → старые running → failed, count правильный.
- `getDistributionSince(now-86400)` → corretly grouped {type,status,count}.
- `countByPromptSnippet("foo")` — LIKE %foo%, only за last 24h.

Migration test: `tests/migration-17.test.ts` → fresh `:memory:` db → migrate → `PRAGMA user_version = 17`, `agent_tasks` table exists, 3 indexes (`idx_agent_tasks_pending`, `_running`, `_distribution`) exist.

## Premortem

| # | Симптом | Mitigation | Recovery |
|---|---------|-----------|----------|
| 1 | `PRAGMA user_version` уже ≥17 на чистом `:memory:` db (кто-то параллельно добавил migration 17) | §Pre-check блокирует старт. Если уже ≥17 — STOP, никаких edits в `schema.ts`. | `FAIL: migration-conflict: user_version=N already, expected 16 before this PR`. НЕ перезаписывать чужую миграцию. |
| 2 | `claimNext` race: 2 параллельных process-инстанса claim'ят один и тот же row | SQLite serializable isolation + `UPDATE ... WHERE id = (SELECT ... LIMIT 1) RETURNING *` атомарны в рамках одного writer'а. Но `bun:sqlite` default — WAL, multiple readers. **Test обязан** запустить 2 concurrent claim'а через `Promise.allSettled` и проверить разные id. | Если test нестабильный → mutex в repo (PR-C2 ответственность). Здесь test FAIL = repo bug, fixить. |
| 3 | CHECK constraint на `type` блокирует unknown тип в будущем | Намеренно — whitelist через миграцию. Документировать что добавление типа = новая migration. | N/A (это feature, не bug). |
| 4 | `idx_agent_tasks_pending` partial index DESC ordering на `priority` — SQLite < 3.36 не поддерживает DESC в partial index | Bun ships SQLite 3.45+. Проверить `sqlite3 --version` ≥3.36 на CI / локально. | Если индекс не создаётся — убрать DESC, ORDER BY клиент-сайд (медленно но работает). |
| 5 | `JSON.parse(row.artifact)` падает на corrupt JSON в БД | Repo wrapper: `try/catch`, на parse-error → возвращать `null` + `logger.warn("agent-tasks", "artifact parse failed", { id, raw: raw.slice(0,200) })`. Не throw. | Если test падает на этом → fix repo, не БД. |
| 6 | Migration `transaction()` rollback оставляет частичный CREATE INDEX | Все 3 индекса + CREATE TABLE + PRAGMA в **одной** `db.transaction(() => { ... })`. Bun `bun:sqlite` транзакция атомарна по rollback. | Если migration упала — `data/test.db` испорчена, удалить и перезапустить тесты. |
| 7 | Тесты случайно используют `data/subbrain.db` вместо `data/test.db` | Hard rule from CLAUDE.md. `tests/agent-tasks-repo.test.ts` обязан использовать `:memory:` или `data/test.db`, **never** prod path. | Если grep `data/subbrain.db` найден в test файле → fix test, run again. |

## Приёмка

Каждый item — точная команда + expected output.

```bash
cd /usr/projects/subbrain
bunx tsc --noEmit                                                              # expect: empty stdout, exit 0
bun run scripts/check-file-size.ts                                             # expect: pass message, exit 0
bun test tests/agent-tasks-repo.test.ts 2>&1 | tail -3                         # expect: "X pass / 0 fail"
bun test tests/migration-17.test.ts 2>&1 | tail -3                             # expect: "X pass / 0 fail"
bun test 2>&1 | tail -3                                                        # expect: "X pass / 0-2 fail" (no NEW regressions)

# File caps
wc -l packages/core/src/db/tables/agent-tasks.ts                                             # expect: ≤150
wc -l packages/core/src/repositories/agent-tasks.repo.ts                                     # expect: ≤150
wc -l packages/core/src/db/tables/agent-tasks/types.ts                                       # expect: ≤80

# Boundary check — никто кроме data/repo не ходит к agent_tasks ещё
grep -rnE 'agent_tasks|agentTasksRepo' packages/agent/src/services/ packages/agent/src/pipeline/ packages/agent/src/scheduler/ 2>/dev/null  # expect: 0 matches
grep -rnE 'agent_tasks|agentTasksRepo' packages/server/src/routes/ 2>/dev/null                                  # expect: 0 matches

# Migration applied
bun -e 'import {MemoryDB} from "./src/db"; const db=new MemoryDB(":memory:"); console.log(db.db.query("PRAGMA user_version").get())'  # expect: { user_version: 17 }

# Schema present
bun -e 'import {MemoryDB} from "./src/db"; const db=new MemoryDB(":memory:"); console.log(db.db.query("SELECT sql FROM sqlite_master WHERE name=\"agent_tasks\"").get())'  # expect: CREATE TABLE ... CHECK(...) ...

# Indexes present
bun -e 'import {MemoryDB} from "./src/db"; const db=new MemoryDB(":memory:"); console.log(db.db.query("SELECT name FROM sqlite_master WHERE type=\"index\" AND tbl_name=\"agent_tasks\"").all())'  # expect: idx_agent_tasks_pending, idx_agent_tasks_running, idx_agent_tasks_distribution

# No 'as any' / raw fetch
grep -nE 'as any' packages/core/src/db/tables/agent-tasks.ts packages/core/src/repositories/agent-tasks.repo.ts             # expect: 0
grep -nE '\bfetch\(' packages/core/src/db/tables/agent-tasks.ts packages/core/src/repositories/agent-tasks.repo.ts          # expect: 0
```

## Definition of Done

1. ✅ `git status` clean.
2. ✅ `git log -1 --format=%s` → "feat(db): add agent_tasks table + repo (PR-C1)".
3. ✅ `git diff HEAD~1..HEAD --name-only | sort` ровно 7 файлов из §Контракт.
4. ✅ Все commands из §Приёмка выдали expected output.
5. ✅ `bunx tsc --noEmit` clean.
6. ✅ `bun test` regression count ≤ baseline (узнать baseline до старта: `git checkout main -- . && bun test 2>&1 | tail -3`, потом обратно).

## Deploy

```bash
ssh root@109.120.187.244
cd /opt/subbrain
docker compose exec subbrain sh -c 'cp /app/data/subbrain.db /app/data/subbrain.db.pre-mig9'
git pull
docker compose build && docker compose up -d
docker compose logs -f | grep -i migration
```

Rollback: восстановить `.pre-mig9` snapshot.

## Известные ограничения

- В этой задаче нет интеграции с `MemoryService` / pool / runners — это PR-C2.
- `done_with_artifact` MCP tool НЕ создаём здесь — PR-C2.
- Free-agent ([packages/agent/src/scheduler/free-agent.ts](../../../packages/agent/src/scheduler/free-agent.ts)) НЕ удаляем — PR-C2 заменит legacy-bridge'ом.

## Escape hatch

При FAIL — одна строка:

```
FAIL: <category>: <≤80-char specific reason>
```

Categories: `migration-conflict` | `tsc-error` | `test-fail` | `file-cap` | `diff-boundary` | `claim-race` | `boundary-leak` | `unknown`.

Примеры:
- `FAIL: migration-conflict: PRAGMA user_version=17 already (someone else added migration_17)`
- `FAIL: claim-race: 2 concurrent claimNext returned same id=42`
- `FAIL: boundary-leak: packages/agent/src/services/foo.ts:18 imports agentTasksRepo (forbidden until PR-C2)`
- `FAIL: file-cap: agent-tasks.ts is 167 lines, max 150`

Stop, не push, не merge. Parent reads, decides.
