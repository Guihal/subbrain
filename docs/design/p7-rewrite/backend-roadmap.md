# Backend Roadmap для P7 Web Rewrite

> Что нужно докрутить в бэкенде чтобы дизайн (см. [00-master-spec.md](./00-master-spec.md)) полноценно заработал. Сгруппировано по приоритету и связи с существующим Wave 2/3 беклогом.

## Обзор

Дизайн ведёт, бэкенд догоняет. Часть требований уже на радаре через существующий kimi-nav.md (Wave 2/3). Часть — новая, не в роадмапе. Этот документ — единый список с явной маркировкой что есть, что в работе, что новое.

**Маркеры:**
- ✅ DONE — реализовано
- 🚧 WIP — в работе по существующему backlog
- 📋 ROADMAP — есть в kimi-nav.md, не начато
- ➕ NEW — не в роадмапе, добавляется по дизайну

---

## 1. Projects (новая концепция) ➕

Дизайн вводит концепцию «проект» как контейнер для группы задач. В текущем backend есть только `tasks.scope` (string field). Нужна полноценная сущность.

**Schema (новая миграция, ≥21):**

```sql
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active',  -- active | archived | completed
  color TEXT,                              -- accent color override (optional)
  deadline_at INTEGER,                     -- Unix seconds
  created_at INTEGER NOT NULL,
  archived_at INTEGER,
  completed_at INTEGER
);

ALTER TABLE tasks ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;
CREATE INDEX idx_tasks_project ON tasks(project_id);
```

**Endpoints:**
- `GET /v1/projects` — list (filter by status, pagination)
- `POST /v1/projects` — create
- `GET /v1/projects/:id` — detail с counters (active_tasks, total_tasks, progress)
- `PATCH /v1/projects/:id` — update title/description/deadline/color
- `POST /v1/projects/:id/archive` — soft-archive
- `POST /v1/projects/:id/restore` — un-archive
- `DELETE /v1/projects/:id` — hard delete (cascade: tasks.project_id → null)
- `GET /v1/projects/:id/tasks` — tasks этого проекта с пагинацией

**Repository:** `packages/core/src/repositories/projects.repo.ts` + `packages/core/src/db/tables/projects.ts`. Service в `packages/agent/src/services/projects.service.ts`.

**Validation:** TypeBox в route, `t.Object({title: t.String({minLength:1, maxLength:200}), ...})`.

---

## 2. Two-pool tasks differentiation ➕

Pool 1 = «Для агентов» (system-generated/agent-targeted), Pool 2 = «Мои» (personal с привязкой к проекту).

Существующий `tasks.scope` field покрывает Pool 1 (autonomous/free-agent/freelance/tg). Pool 2 = задачи с `scope='default'` плюс наличие `project_id` или его отсутствие.

**Изменения:**

- В service-слое функция `isAgentPool(task)` → `task.scope !== 'default'`.
- Endpoint фильтр: `GET /v1/tasks?pool=agent|personal&project_id=<uuid?>`
- Response augment: каждая task строка содержит computed `pool: "agent" | "personal"` + `project: {id,title} | null`.

**Schema:** не нужны изменения, только query logic.

---

## 3. Auto-tracker (timer) ➕

Простой таймер на задаче: start/stop, накопление total_spent, опциональный pinned auto-track.

**Schema (новая миграция):**

```sql
CREATE TABLE task_timers (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,                        -- NULL когда running
  elapsed_seconds INTEGER,                 -- computed at stop
  pinned_auto BOOLEAN NOT NULL DEFAULT 0,  -- флаг: трекер запущен через pinned-auto-track
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_task_timers_task ON task_timers(task_id);
CREATE INDEX idx_task_timers_running ON task_timers(ended_at) WHERE ended_at IS NULL;

ALTER TABLE tasks ADD COLUMN pinned_for_tracking BOOLEAN NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN total_seconds_spent INTEGER NOT NULL DEFAULT 0;
```

**Endpoints:**
- `POST /v1/tasks/:id/timer/start` — старт (отказ если уже running по этой task)
- `POST /v1/tasks/:id/timer/stop` — стоп текущего, запись elapsed в task.total_seconds_spent
- `GET /v1/tasks/:id/timer/current` — running timer этой task (если есть)
- `GET /v1/tasks/timers/active` — все running timers (обычно 0 или 1)
- `GET /v1/tasks/:id/timers` — history per task (pagination)
- `GET /v1/tasks/timers/today` — все timers за сегодня (для full panel в Tasks)

**Pinned auto-track:** PATCH `/v1/tasks/:id { pinned_for_tracking: true }`. Background worker (можно reuse scheduler) каждые 30с проверяет: если task pinned и есть running timer → продолжается; если нет running → старт нового.

**Constraint:** только один running timer глобально. При start второго — auto-stop первого.

---

## 4. Recurring tasks ➕

Preset selector в дизайне (daily/weekly/monthly) + custom cron placeholder.

**Schema:**

```sql
ALTER TABLE tasks ADD COLUMN recurring_pattern TEXT;     -- 'daily' | 'weekly' | 'monthly' | NULL
ALTER TABLE tasks ADD COLUMN recurring_template_id TEXT; -- для копий: ссылка на исходник
CREATE INDEX idx_tasks_recurring_template ON tasks(recurring_template_id);
```

**Background scheduler:** `packages/agent/src/scheduler/recurring-tasks.ts` — каждый час проходит по tasks с `recurring_pattern IS NOT NULL AND status='done'`, генерит copy с обновлённым `due_at` если время.

**Endpoint:** PATCH `/v1/tasks/:id { recurring_pattern: 'daily'|'weekly'|'monthly'|null }`.

**Custom cron** — V2, сейчас placeholder в UI.

---

## 5. Memory edges graph endpoint 🚧

Существует: `GET /v1/memory/edges` + `GET /v1/memory/edges/related`. Для graph view в дизайне нужен subgraph endpoint:

**New endpoint:**

```
GET /v1/memory/:layer/:id/graph?hops=1
```

Возвращает: центральная нода + neighbors с edges на N hops вокруг (default 1, max 2). Response:

```json
{
  "nodes": [
    {"id": "...", "layer": "shared", "title": "...", "kind": "fact"},
    ...
  ],
  "edges": [
    {"from_id": "...", "from_layer": "...", "to_id": "...", "to_layer": "...", "kind": "mentions", "weight": 0.8},
    ...
  ]
}
```

**Limit:** max 50 nodes в response (UI drops сверх).

**Repository extension:** `MemoryRepository.getSubgraph(layer, id, hops)`.

---

## 6. Bi-temporal memory queries 🚧

P3-2 миграция (nullable cols `valid_at`, `recorded_at`) уже сделана. Нужно расширить endpoint'ы:

- `GET /v1/memory/shared?as_of=<unix>` — фильтр по `valid_at <= as_of OR valid_at IS NULL`.
- Same for context/archive/agent.

**Repository:** добавить optional `as_of` параметр в list-методы.

P3-5 (memory_blocks table mig 18) — STRONG-MODEL ONLY, отдельный пакет.

---

## 7. Pending memory inbox enhancements 🚧

Существует: `GET /v1/memory/pending` + `PATCH /v1/memory/:layer/:id/status`.

**Нужно добавить:**

- `POST /v1/memory/pending/bulk` — body `{ items: [{layer, id, action: 'approve'|'reject'}] }`. Транзакция, atomic.
- `GET /v1/memory/confidence-distribution?layer=shared|context` — гистограмма confidence распределения existing записей в виде buckets `[0.0-0.1, 0.1-0.2, ..., 0.9-1.0]`. Для confidence-tuner UI.
- `GET /v1/memory/confidence-tuner/preview?threshold=0.85&layer=shared` — count записей за last 7 days которые попали бы в pending при threshold X.

---

## 8. Agent runs registry 📋 (P2-1..7)

Уже в Wave 2 backlog (`P2-1` STRONG-MODEL для миграции 19, `P2-2` repo, `P2-3` runner, `P2-4` artifact tool, `P2-5` dispatch, `P2-6` memory integration, `P2-7` rate-limit).

**Дизайн дополнительно требует:**

- `GET /v1/runs` — list с фильтрами (status, scope, since, agent_id), пагинация.
- `GET /v1/runs/active` — только running.
- `GET /v1/runs/:id` — full detail с метаданными.
- `GET /v1/runs/:id/steps` — full trace из OTel-spans (или из хранилища шагов если решим persist).
- `GET /v1/runs/:id/artifacts` — final answer + intermediate artifacts.
- **SSE:** `GET /v1/runs/stream` — push когда run меняет status (running → done/failed/cancelled), новые steps.

---

## 9. A2A rooms transcripts 📋 (P6-1..6)

Уже в Wave 2 backlog. P6-3 (transcripts schema) STRONG-MODEL ONLY — нужно решить: отдельная `a2a_messages` table или payload в artifact'е. Для дизайна предпочтительнее отдельная table — чище query для conversation tree.

**Schema (если выбираем table):**

```sql
CREATE TABLE a2a_rooms (
  id TEXT PRIMARY KEY,
  task TEXT NOT NULL,
  team_lead_role TEXT NOT NULL,
  participants TEXT NOT NULL,            -- JSON array of role strings
  status TEXT NOT NULL DEFAULT 'running', -- running | done | failed
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  final_answer TEXT,
  parent_run_id TEXT REFERENCES agent_runs(id)
);

CREATE TABLE a2a_messages (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES a2a_rooms(id) ON DELETE CASCADE,
  parent_message_id TEXT,                -- для threading
  role TEXT NOT NULL,                    -- teamlead | coder | critic | ...
  round INTEGER NOT NULL,                -- 1, 2, 3 (раунд синтеза)
  content TEXT NOT NULL,
  metadata TEXT,                         -- JSON: tokens, latency, etc.
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_a2a_messages_room ON a2a_messages(room_id);
```

**Endpoints:**
- `GET /v1/rooms` — list с filters (status, since)
- `GET /v1/rooms/:id` — detail с messages (грузим все, не пагинация — обычно <50)
- `POST /v1/rooms` — manual create (для testing UI)

---

## 10. Scheduler control endpoints ➕ (частично NEW)

Существует только для freelance scout. Нужно унифицировать.

**Endpoints:**

```
POST /v1/scheduler/:name/start         # name: autonomous | free-agent | freelance | recurring-tasks
POST /v1/scheduler/:name/stop
GET  /v1/scheduler/:name/status        # { running, started_at, last_tick_at, last_error, next_tick_at }
GET  /v1/scheduler/:name/config        # current env-derived config (interval, max_steps, etc.)
PATCH /v1/scheduler/:name/config       # ⚠️ runtime override без перезапуска (требует state-store для overrides)
GET  /v1/scheduler/:name/history       # last N runs/findings
```

**Free-agent специфично:**
- `GET /v1/scheduler/free-agent/chats` — текущий список TG-chats для send-target
- `PATCH /v1/scheduler/free-agent/chats` — body `{chat_ids: [...]}` (новая функция, требует backend addition в `free-agent.ts`: `FREE_AGENT_TG_CHATS=multi`).

**Реализация:** state-store для runtime config'ов через layer1_focus или новая таблица `scheduler_config`.

---

## 11. Backup endpoints 📋 (8c-1..6)

Уже в Wave 3 backlog. Дизайн требует:

- `POST /v1/backup/trigger` — manual VACUUM INTO
- `GET /v1/backup/status` — `{ last_at, size_bytes, retention_days, next_scheduled_at, location }`
- `GET /v1/backup/history` — list past backups (last 10)
- `PATCH /v1/backup/config` — `{ retention_days, schedule_cron }`

Operator auth flag — обязательно (8c в backlog помечен SECURITY).

---

## 12. Plugin runtime endpoints 📋 (A2-1..9)

Уже в Wave 2 backlog (A2-1/2/3 done, A2-4..9 pending). Дизайн требует:

- `GET /v1/plugins` — list installed с metadata
- `GET /v1/plugins/:name` — detail с registered hooks
- `PATCH /v1/plugins/:name` — `{ enabled: bool }`
- `POST /v1/plugins/:name/reload` — hot-reload без рестарта сервера
- `GET /v1/plugins/:name/hooks` — какие хуки регистрирует (pre/post tool, pre/post phase)

---

## 13. MCP tool detail endpoint ➕

Существует `GET /mcp/tools/list` (массив) и `POST /mcp/tools/call`. Для browser+tester нужен detail endpoint:

```
GET /mcp/tools/:name
```

Response:
```json
{
  "name": "memory_search",
  "description": "...",
  "scope": "public",
  "input_schema": { /* JSON Schema */ },
  "output_schema": { /* JSON Schema */ },
  "examples": [ /* optional sample calls */ ]
}
```

**Реализация:** extract из существующего MCP registry (`mcp/registry/*.tools.ts` уже хранит все нужное).

---

## 14. Code-tool editor CRUD ➕

Сейчас есть `create_code_tool` через MCP (agent-only). Дизайн требует REST для UI:

**Endpoints:**

- `GET /v1/code-tools` — list (filter by created_by_agent, status)
- `GET /v1/code-tools/:id` — full code + metadata
- `POST /v1/code-tools` — create (manual)
- `PATCH /v1/code-tools/:id` — edit code/description (с validation через существующий `code-tool-validators.ts`)
- `DELETE /v1/code-tools/:id`
- `POST /v1/code-tools/:id/run` — sandbox execute с test input → result + timing
- `GET /v1/code-tools/:id/runs` — history (когда запускался, какой input, output, error)

**Schema augment (если нет):**
```sql
CREATE TABLE code_tool_runs (
  id TEXT PRIMARY KEY,
  code_tool_id TEXT NOT NULL REFERENCES code_tools(id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  input_json TEXT NOT NULL,
  output_json TEXT,
  error_json TEXT,
  caller_agent TEXT
);
```

---

## 15. Approval flow (full backend) 📋 (8a-1..7)

Уже в Wave 3 backlog. Дизайн требует полную реализацию:

**Schema (P8a-1 STRONG-MODEL):**

```sql
CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  action_type TEXT NOT NULL,                 -- 'tool_call' | 'memory_write' | 'tg_send' | ...
  action_payload TEXT NOT NULL,              -- JSON
  context_facts TEXT,                        -- JSON array of memory_ids used in decision
  requested_at INTEGER NOT NULL,
  responded_at INTEGER,
  response TEXT,                             -- 'approve' | 'reject' | NULL
  comment TEXT,
  responded_via TEXT,                        -- 'web' | 'telegram'
  expires_at INTEGER                         -- auto-reject если не ответили
);
CREATE INDEX idx_approvals_pending ON approvals(responded_at) WHERE responded_at IS NULL;
```

**Endpoints:**
- `POST /v1/approvals` — system creates request
- `GET /v1/approvals` — inbox (filter status, pagination)
- `GET /v1/approvals/:id` — full context
- `PATCH /v1/approvals/:id` — `{ response, comment }` (also fires TG-bridge sync)
- `POST /v1/approvals/bulk` — bulk approve/reject
- `GET /v1/approvals/audit` — timeline с filters
- **SSE:** `GET /v1/approvals/stream` — push при новых pending

**Telegram bridge:** двунаправленная sync. Web approve → TG message edited с маркером "approved by web". TG approve → web inbox запись disappears.

---

## 16. Memory rollback enhanced ➕

Существует `POST /v1/memory/restore`. Дизайн требует preview:

```
GET /v1/memory/archive/:id/preview
```

Response: что именно будет восстановлено и в какой layer (на основе original_layer field в archive entry).

---

## 17. TG chats management ➕

MCP-tools уже есть (`tg_include_chat`, `tg_exclude_chat`). Нужны REST endpoints для UI:

- `GET /v1/telegram/chats` — list с current policy (included/excluded), last message preview, unread count, type (private/group/channel/bot)
- `GET /v1/telegram/chats/:id` — detail с per-chat settings
- `PATCH /v1/telegram/chats/:id` — `{ included: bool, pii_policy: 'strict'|'standard'|'none' }`

**PII policy** wire-in идёт по 8e-1..7 (Wave 3, частично NEW в плане UI).

---

## 18. Cost/latency dashboard endpoints ➕ (расширение P5)

Существует `GET /v1/metrics/runs`. Нужно расширение:

- `GET /v1/metrics/sparkline?metric=cost|tokens|latency|errors&period=day|week|month&model=<role?>` — bucketed array для sparkline
- `GET /v1/metrics/by-model?period=day` — breakdown по моделям с p50/p95/p99 latency, cost, error_rate
- `GET /v1/metrics/by-provider?period=day` — RPM-usage по провайдерам, error rate

---

## 19. Logs explorer enhancements ➕ (расширение существующих /v1/logs)

- Cursor-based pagination для virtualized list (current: offset)
- `GET /v1/logs/sessions/:id/around/:entry_id?window=10` — entries до/после конкретной (для quick-link "что было до/после")
- Расширить filters: stage (pre/main/post), tool_name, latency_bucket

---

## 20. Health snapshot endpoint ➕

```
GET /v1/health/snapshot
```

Response:
```json
{
  "system": { "version": "...", "uptime_seconds": ..., "memory_mb_used": ..., "db_size_mb": ... },
  "providers": [
    { "name": "nvidia", "rpm_current": 12, "rpm_limit": 40, "queue_depth": 0, "last_error_at": null }
  ],
  "schedulers": [
    { "name": "night-cycle", "running": false, "last_run_at": ..., "last_result": "ok" },
    { "name": "free-agent", "running": true, "next_tick_at": ... }
  ],
  "backup": { "last_at": ..., "size_bytes": ..., "next_scheduled_at": ... }
}
```

**SSE:** `GET /v1/health/stream` — push every 5s.

---

## 21. Settings management ➕

Сейчас config через env. Дизайн требует UI:

- `GET /v1/settings` — read-only env-derived snapshot
- `POST /v1/settings/auth-token/rotate` — generates new token, returns once
- `GET /v1/settings/feature-flags` — current values
- `PATCH /v1/settings/feature-flags/:name` — runtime override (нужен state-store)

**Flags candidates:** `NIGHT_CYCLE_HOUR_UTC`, `FREE_AGENT_INTERVAL_MIN`, `FREE_AGENT_MAX_STEPS`, `AUTONOMOUS_MAX_STEPS`, `FREELANCE_POLL_MIN`, etc.

---

## 22. System info endpoint ➕

```
GET /v1/system/info
```

Response: `{ version, git_sha, started_at, uptime_seconds, memory_mb_used, db_size_mb, deployment_health }`. Lightweight для sticky header.

---

## 23. Quick-add task NLP parser ➕ (опционально)

Дизайн упоминает "поставь задачу на пятницу" → modal с распарсенным due_at. Можно реализовать:

```
POST /v1/tasks/parse
```

Body: `{ text: "поставь задачу позвонить Васе на пятницу 18:00" }`

Response: `{ title: "Позвонить Васе", due_at: <unix>, priority: 5 }` (через flash-модель с structured output).

**Если не реализуем** — UI просто открывает empty quick-add modal.

---

## 24. Bulk operations standardization ➕

Дизайн часто использует bulk approve/reject/archive. Стандартизировать pattern:

```
POST /v1/<resource>/bulk
{ "items": [{ "id": "...", "action": "..." }, ...] }
```

В транзакции, atomic, return per-item result.

---

## Связь с существующим Wave 2/3 backlog

| Дизайн нужно | Существующий packet | Статус |
|---|---|---|
| Pool monitor (Pool 1) | P2-1..7 (agent pool) | 📋 (P2-1, P2-7a strong-model) |
| Pool monitor SSE | новое | ➕ |
| A2A rooms viewer | P6-1..6 | 🚧 (P6-1/2 done, P6-3 strong-model) |
| Bi-temporal memory | P3-1..5 | 🚧 (P3-1/2 done, P3-5 strong-model) |
| Plugin admin | A2-1..9 | 🚧 (A2-1/2/3 done) |
| Approval inbox | 8a-1..7 | 📋 (8a-1 strong-model) |
| Backup panel | 8c-1..6 | 📋 (security flag required) |
| TG PII policy | 8e-1..7 | 📋 (8e-3 mig 20 reserved) |

**Новые packets, которые нужно добавить в kimi-nav.md:**

- **P9-1..3 Projects** (schema + repo + endpoints + service)
- **P9-4 Two-pool tasks** (query logic + response augment)
- **P10-1..3 Auto-tracker** (schema + endpoints + pinned-auto worker)
- **P10-4 Recurring tasks** (schema + scheduler)
- **P11-1..3 Scheduler unified control** (state-store + endpoints + free-agent multi-chats)
- **P12-1..3 Health/settings/system info endpoints**
- **P13-1..3 Code-tool CRUD UI** (REST endpoints поверх существующих MCP)
- **P14-1 Memory subgraph endpoint** (graph view)
- **P14-2 Confidence tuner endpoints** (preview + distribution)
- **P14-3 Bulk operations standardization**
- **P15-1 Cost/latency sparkline endpoints**
- **P15-2 Logs explorer enhancements** (cursor pagination + around-entry)

Эти `P9-P15` имена черновые, упорядочить и закрепить в kimi-nav.md отдельным актом.

---

## Приоритизация для запуска P7 порта в Nuxt

Когда дизайн утверждён и начинается реальная имплементация в Vue, минимальный backend-cut должен покрывать:

**Tier 1 (без них UI пустой):**
- Projects CRUD (P9)
- Auto-tracker (P10-1..3)
- Memory subgraph (P14-1)
- Health snapshot (P12-1)
- Confidence tuner (P14-2)

**Tier 2 (без них core flows partial):**
- Pool monitor с runs registry (P2 closure + SSE)
- Plugin admin (A2 closure)
- Approval inbox (8a closure)
- Scheduler unified control (P11)

**Tier 3 (дополнительно — улучшают UX, можно отложить):**
- A2A rooms viewer (P6 closure)
- Backup panel (8c closure)
- TG PII policy (8e closure)
- Recurring tasks (P10-4)
- Cost sparklines (P15-1)
- Logs enhancements (P15-2)
- NLP task parser (если решим)

---

## Notes

- Все новые endpoint'ы — TypeBox-валидация, через repository layer, в транзакции при мутациях.
- File-cap 150 lines на каждый новый файл (см. CLAUDE.md guardrails).
- Tests обязательны: bun:test для unit, layer-boundary тесты для repository изоляции.
- Миграции в одном PR не bundle с feature — отдельные packets.
- SSE endpoints — heartbeat `: ping\n\n` каждые 5s, idleTimeout 255.
