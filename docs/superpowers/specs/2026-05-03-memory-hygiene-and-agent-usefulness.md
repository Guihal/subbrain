# Memory hygiene + agent usefulness rewrite

**Date:** 2026-05-03
**Status:** DRAFT — awaiting user review before `/task` handoff
**Source incident:** free-agent fires 18-20 раз без артефакта; hippocampus спамит legacy/duplicate в `shared`/`context`; tasks полнятся хламом несмотря на 3d cleanup
**Inspection:** prod data via curl `127.0.0.1:4000/v1/memory/*` (2026-05-03)

## Goals

1. Остановить memory rot на ингесте (write-time enforcement, не post-cleanup-only).
2. Добавить регулярный night janitor (compress + dedup + expire).
3. Переписать free-agent в openclaw-style: каждый тик = законченная world-task с артефактом.
4. Дать teamlead/memory роли «характер» — без потери функции (synthesis правил, hippocampus extraction).
5. Закрыть schema-bypass для `memory_write` (registry vs. validators).

Non-goals:
- Не трогать `arbitration-room.ts` core voting/synthesis logic — только prompts.
- Не менять 4-layer схему БД.
- Не вводить новые модели в `model-map.ts`.

## Operational principle: NO TOKEN ECONOMY

**Агент НЕ экономит ресурсы.** NVIDIA NIM, MiniMax, web search — у юзера unlimited / бесплатно. «Экономия» tool-calls / steps / context — это анти-паттерн который убивает usefulness.

Конкретно — **запрещены** в любом prompt'е (free-agent, hippocampus, teamlead, runners):
- «постарайся уложиться в N шагов»
- «не используй tool если можно без него»
- «минимизируй контекст / экономь токены»
- «вызывай tool только если нужно»
- любые вариации «be efficient / be concise / save resources» применительно к **выбору действий** (не путать с output formatting — там terse OK).

**Поощряется в каждом runner-prompt'е:**
- «используй tools агрессивно — embed/rerank/web/memory_search дешевле твоей нерешительности»
- «лучше 50 шагов с артефактом чем 5 шагов "noop"»
- «параллельные tool calls когда независимы — экономия времени, не токенов»
- «`memory_search` перед write — cheap insurance, делай всегда»

`maxSteps` — это safety ceiling против бесконечных циклов, не KPI. Артефакт за 80 шагов лучше «noop» за 10.

## Root causes (from prod inspection 2026-05-03)

| ID | Cause | Evidence |
|----|-------|----------|
| R1 | `memory_write` registry schema принимает любую `category: string` | [src/mcp/registry/memory.tools.ts:55](../../src/mcp/registry/memory.tools.ts) — `t.Optional(t.String(...))`, не `t.Union` whitelist |
| R2 | Free-agent дампит 2000-char markdown в `context` вместо классифицированных фактов | prod `context` rows с `category: "free-agent-digest"`, длина 1500-2000 |
| R3 | Нет on-write dedup, embedding не используется при insert | `memory.service.ts insertContext` пишет без cosine-check |
| R4 | `expires_at` никогда не выставляется (0/200 prod rows) | `SELECT count(*) FROM memory WHERE expires_at IS NOT NULL` = 0 |
| R5 | Free-agent goal "be curious" non-falsifiable → idle loops | [src/scheduler/free-agent.ts:21-43](../../src/scheduler/free-agent.ts) — 4 «принципа» без acceptance criteria |
| R6 | Night cycle compresses logs but не cleanup memory rows | [src/services/night-cycle/](../../src/services/night-cycle/) — фокус на logs, не на shared/context |
| R7 | Teamlead synthesis prompt — голый «consensus rule», нет verification clause или personality | [src/pipeline/arbitration/prompts.ts:buildSynthesisSystemPrompt](../../src/pipeline/arbitration/prompts.ts) |

## Architecture

5 PR, последовательно. Каждый — отдельный файл-таск в `docs/tasks/`.

### PR-A — Schema enforcement + dedup + expires defaults (highest impact)

**Цель:** memory_write на ингесте отбрасывает мусор. Бьёт R1, R3, R4.

**Files:**
- [src/mcp/registry/memory.tools.ts](../../src/mcp/registry/memory.tools.ts) — заменить `category: t.Optional(t.String(...))` на `t.Union([t.Literal("profile"), t.Literal("preference"), ...])` для shared, аналогично для context. Список — из `WHITELIST_SHARED`/`WHITELIST_CONTEXT` в `post/validators.ts`.
- [src/pipeline/agent-pipeline/post/validators.ts](../../src/pipeline/agent-pipeline/post/validators.ts) — экспортировать validators как чистый module (без post-pipeline dep), чтобы `mcp/tools/memory/write-shared.ts` и `write-context.ts` могли вызывать.
- [src/mcp/tools/memory/write-shared.ts](../../src/mcp/tools/memory/write-shared.ts) + [write-context.ts](../../src/mcp/tools/memory/write-context.ts) — вызывать `validateForShared`/`validateForContext` ПЕРЕД `memoryService.insert*`. На fail → `ToolError{code:"validation_failed", message: ...}`.
- **On-write dedup:** новый helper `src/services/memory/dedup.ts`:
  - Embed candidate → `rag_search` top-3 в той же layer/category.
  - **Per-category mode** (premortem fail-mode-2 fix):
    - **Strict** (для стабильных: `profile/skill/architecture`): cosine ≥0.92 → reject как duplicate.
    - **Supersede** (для динамичных: `preference/goal/relationship/style/constraint/decision/learning/project/bug`): cosine ≥0.95 → reject; 0.85-0.95 → insert + `supersedes_id` + soft-archive старого row; <0.85 → fresh.
  - Cosine < 0.85 везде → fresh insert.
  - `MEMORY_DEDUP_MODE_BY_CATEGORY` const в `validators.ts` (single source).
  - Используется в обоих write-shared/context.
- **Differential TTL** при insert (если агент не выставил `expires_at`):
  - shared: `profile/preference/skill` = бессрочно; `goal/relationship/constraint/style` = +180 дней.
  - context: `decision/architecture/learning` = +90 дней; `project/bug` = +30 дней.
  - `TIME_BOUND_CATEGORIES` (plan/strategy/priority/urgent/deadline) — обязательный `expires_at` от агента, иначе reject.

**Tests:**
- `tests/memory-validators.test.ts` (уже есть, 210 lines) — расширить cases для on-write dedup.
- Новый `tests/memory-write-enforcement.test.ts`:
  - whitelist пропускает; non-whitelist reject;
  - dup cosine 0.95 → `duplicate` error;
  - dup 0.88 → insert + supersedes link;
  - TIME_BOUND без `expires_at` → reject;
  - default TTL прописан правильно по категории.

**Acceptance:**
- 100% существующих tests pass.
- Free-agent при попытке `memory_write {category:"free-agent-digest", content:"..."}` получает `validation_failed`.

---

### PR-B — Night janitor (memory cleanup + one-time legacy purge)

**Цель:** Регулярная чистка expired/duplicate/legacy в `shared`/`context`/`tasks`. Бьёт R6 + остатки R3/R4.

**Files:**
- Новый `src/services/night-cycle/memory-janitor.ts` (~120 lines):
  - **Phase A — expired:** `DELETE FROM memory WHERE expires_at < now()`. Лог count.
  - **Phase B — duplicates:** для каждого layer/category, для каждой свежей пары (≤7d), проверить cosine; если ≥0.92 — оставить новейшую, остальных в archive с тегом `dedup-{batch_date}`.
  - **Phase C — legacy purge (one-time флаг `JANITOR_LEGACY_SWEEP=true`):** строки с `category` НЕ в whitelist ИЛИ длина > MAX_*_CONTENT — move в archive layer с тегом `legacy-cleanup-2026-05-03`. Revertable, не delete.
  - **TG-confirm gate (premortem fail-mode-5 fix):** перед фактическим archive — TG-сообщение юзеру: `«About to archive N rows. Top reasons: bad-category=X, oversize=Y. Sample preview: <5 random rows>. Reply YES to proceed (1h timeout)».` Без YES — Phase C skip, log warn. После execution — `POST /v1/memory/restore?layer=archive&id=N` endpoint в [src/routes/memory.ts](../../src/routes/memory.ts) для отката.
  - **Phase D — task hygiene:** `DELETE FROM tasks WHERE status='done' AND completed_at < now()-30d`. Уже частично есть в night-cycle stale-task pass — расширить до status-aware. **Применяется к существующей `tasks` table (не к `agent_tasks` из PR-C — у той свой retention в самой pool logic).**
- Wire в `src/services/night-cycle/index.ts` после log-compression phase.
- Новый env: `JANITOR_LEGACY_SWEEP=false` (default), `JANITOR_DEDUP_THRESHOLD=0.92`.

**Tests:**
- `tests/night-cycle-memory-janitor.test.ts`: создать fixtures с expired/dup/legacy → run janitor → проверить counts + archive entries.

**Acceptance:**
- One-time prod run после deploy: ≥50% reduction в `context` row count, нет потери whitelist-compliant rows.
- Daily janitor adds ≤2 min к night cycle.

---

### PR-C — Agent-pool: typed tasks + parallel runners (openclaw-style)

**Декомпозиция (premortem fail-mode-8 fix):** PR-C сам разбивается на 4 mergeable PR:
- **PR-C1** — `agent_tasks` table + migration + repo-layer (`src/db/tables/agent-tasks.ts`, `src/repositories/agent-tasks.repo.ts`). После merge — table есть, никто не пишет.
- **PR-C2** — single-runner pool engine + `free` runner only + `done_with_artifact` tool. Заменяет старый free-agent. После merge — prod работает на одном runner type, можно фидбекать.
- **PR-C3** — `clear` / `check-tg` / `research` / `find-new-task` runners. После merge — pool диверсифицирован, sequential.
- **PR-C4** — parallel concurrency (`maxConcurrent>1`) + per-type rate limits + type-quota balance (premortem fail-mode-4 fix). После merge — pool на полной мощности.

Если останавливаемся на C2 — система рабочая, free-agent заменён, типизация ждёт месяц.



**Цель:** заменить single `free-agent` на **унифицированный pool engine** с typed tasks. Каждый тик — одна задача из пула, end-to-end, артефакт обязателен (или явный noop с reason). Parallel concurrency 2-3 через NVIDIA RPM headroom. Бьёт R5.

**Vision (per user's openclaw + pool reframe):** не один «куда-нибудь пойдёт» агент, а **pool типизированных задач** + единый scheduler. Базовый цикл: возьми task из pool → если пусто, задача = `find-new-task` (агент сам пополняет pool). Task-types: `free` / `clear` / `check-tg` / `research` / extensible.

**DB schema** — новая таблица `agent_tasks`:
```sql
CREATE TABLE agent_tasks (
  id          INTEGER PRIMARY KEY,
  type        TEXT NOT NULL,         -- 'free' | 'clear' | 'check-tg' | 'research' | ...
  prompt      TEXT NOT NULL,         -- task-specific instruction (часто generated by find-new-task)
  status      TEXT NOT NULL,         -- 'pending' | 'running' | 'done' | 'noop' | 'failed'
  priority    INTEGER DEFAULT 0,     -- higher = sooner
  scheduled_at INTEGER,              -- unix sec, optional defer
  started_at  INTEGER,
  finished_at INTEGER,
  artifact    TEXT,                  -- JSON {type, content, url?}
  reason      TEXT,                  -- для noop/failed
  created_by  TEXT,                  -- 'find-new-task' | 'user' | 'cron' | 'self-recurse'
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_agent_tasks_pending ON agent_tasks(status, scheduled_at) WHERE status='pending';
```

**Files:**
- Новый каталог `src/scheduler/agent-pool/`:
  - `index.ts` (~80 lines) — `installAgentPoolScheduler({maxConcurrent, intervalMs})`. Polls pending tasks, dispatches до `maxConcurrent`. Уважает RPM router headroom.
  - `pool.ts` (~120 lines) — `AgentTaskPool`: `claim()` (pending → running, atomic), `complete(id, artifact)`, `noop(id, reason)`, `fail(id, error)`, `findNew(type)` (genrates `find-new-task` если пусто), `enqueue({type,prompt,priority})`.
  - `runners/free.ts` — prompt + tool-allowlist для exploratory web/code-tool tasks (D1-D4 deliverables ниже).
  - `runners/clear.ts` — prompt для memory cleanup tasks (subsets PR-B janitor logic, инкрементально).
  - `runners/check-tg.ts` — prompt для TG inbox monitoring (новые сообщения юзеру в чатах ≥1 unread).
  - `runners/research.ts` — focused research-by-topic, артефакт = ≤3 shared-facts с supersedes-aware writes.
  - `runners/find-new-task.ts` — мета-задача: агент анализирует memory + recent activity + open backlog → `enqueue` 1-3 новых task в pool.
  - `types.ts` — `AgentTaskType`, `AgentTaskRecord`, `RunnerConfig {model, maxSteps, toolScope, prompt}`.
- [src/db/tables/](../../src/db/tables/) — новый `agent-tasks.ts` table module (raw SQL + row mapping per repo-layer rule).
- Новый repo `src/repositories/agent-tasks.repo.ts`.
- [src/db/schema.ts](../../src/db/schema.ts) — migrations entry.
- **Удалить** [src/scheduler/free-agent.ts](../../src/scheduler/free-agent.ts) — полностью замещается pool. Migration: на boot, если `FREE_AGENT=true` env present, scheduler одноразово enqueue'ит задачу `{type:"free", prompt:"<legacy free-agent prompt>"}` для совместимости и логирует deprecation warning.

**Runner contract** (общий для всех типов):
```
Ты выполняешь задачу type=<TYPE>. Промпт ниже.
ACCEPTANCE: вызвать `done_with_artifact` с status="complete" + artifact ИЛИ status="noop" + reason.
ANTI-IDLE: 3 read-only шага подряд → system-message переключения.
SAFETY: payments / irreversible / cookies — запрещено. SMS/email — suggest через TG.
<TASK-SPECIFIC PROMPT>
```

**Task-type prompts (краткие):**

- `free` (D1-D4):
  - D1: создай code-tool, smoke-call, артефакт = tool_id+stdout.
  - D2: research-задача с ≤3 structured facts в `shared`/`context`.
  - D3: web-route ≥5 clicks, артефакт = URL/screenshot/data.
  - D4: PR/issue в репо юзера (ВСЕГДА TG-confirm перед submit).
- `clear`:
  - artifact = `{type:"cleanup", removed: N, archived: M, layer: "context"|"shared"}`.
  - Инструменты: `memory_search`, `memory_archive`, `memory_delete` (если будет добавлен) или batch `memory_write {layer:"archive"}` + reference.
  - Granular: одна задача чистит одну (layer, category) пару.
- `check-tg`:
  - artifact = `{type:"tg_check", chats_checked: [...], unread_summary: "..."}`.
  - Инструменты: `tg_list_chats`, `tg_read_chat`, `memory_write` для значимых сообщений.
  - Безопасно read-only — никогда не отвечает без юзер-confirm.
- `research` — sub-case `free`/D2 но с заданной topic-spec (priority field).
- `find-new-task` (special meta):
  - artifact = `{type:"enqueued", count: N, types: [...]}`.
  - Не имеет smoking gun — успех = ≥1 enqueue.
  - Запускается когда `claim()` returns empty И прошло ≥10 min с последнего find-new-task.
  - **Type-quota balance** (premortem fail-mode-4 fix): перед enqueue проверяет rolling 24h distribution `complete`-тасков. Если type=`research` >70% → принудительно enqueue D1/D3 prompts (free-runner, deliverable D1 или D3). Цель: за rolling 24h ≥30% complete-tasks ≠ research.
  - **Dedup на enqueue:** прежде чем INSERT новой task, `memory_search` + проверка `agent_tasks WHERE prompt LIKE %snippet%` за последние 24h. Если уже есть pending/running/recent-done — пропустить (premortem fail-mode-3).

**Concurrency:**
- `maxConcurrent` env, default `2`. Поднять до 3 если NVIDIA RPM headroom (router exposes `freeRpm()`).
- Pool runner проверяет `router.isOverloaded` перед claim — если true, пропускает тик.
- Per-type rate limit: `check-tg` — max 1 раз в 5 мин; `clear` — max 1 параллельно (DB-write contention); `free`/`research` — без ограничений сверх `maxConcurrent`.

**Zombie-task recovery (premortem fail-mode-3 fix):**
- На каждом pool-tick перед `claim()`: `UPDATE agent_tasks SET status='failed', reason='timeout', finished_at=now() WHERE status='running' AND started_at < now()-1800` (30 min hard cap).
- В `find-new-task` skip-if-recent: `SELECT 1 FROM agent_tasks WHERE prompt LIKE ? AND created_at > now()-86400` — не дублирует за 24h.

**`done_with_artifact` tool** (новый, registry):
- Input: `{ status: "complete" | "noop", artifact?: {type, content, url?}, reason?: string }`.
- Server-side: `status==="complete"` requires `artifact`; `status==="noop"` requires `reason`.
- Pool helper маппит → `pool.complete(id, artifact)` / `pool.noop(id, reason)`.

**TG digest format:**
```
🤖 Agent pool — 2026-05-03 12:34
✅ free#142 — D1 created code-tool `weather_check_kazan`, smoke pass
⚪ check-tg#143 — noop (no unread в watched chats)
✅ clear#144 — archived 12 dup rows (context/project)
✅ research#145 — wrote 2 facts to shared (preference)
```

**Tests:**
- `tests/agent-pool.test.ts`: claim atomicity (parallel claim не возвращает один и тот же row), `complete`/`noop`/`fail` lifecycle, `find-new-task` enqueue gate (10-min cooldown).
- `tests/agent-pool-runners.test.ts` (mock LLM): каждый runner на complete/noop returns proper artifact shape.
- `tests/done-with-artifact.test.ts`: validation rules (complete без artifact → reject, noop без reason → reject).

**Acceptance:**
- 7 days run on prod: ≥40% запусков с `complete` artifact (vs ~0% сейчас).
- Pool depth (pending) держится 3-15 в среднем (find-new-task работает).
- Параллельные 2 runners без RPM 429 errors.
- TG digest читаемый, юзер видит конкретные artefakty.

---

### PR-D — Hippocampus rewrite (post-extractor)

**Цель:** post-pipeline extractor пишет фокусно: 0-3 факта на exchange, не «всё подряд». Бьёт R2 на ingestion-side.

**Files:**
- [src/pipeline/agent-pipeline/post/prompt.ts](../../src/pipeline/agent-pipeline/post/prompt.ts) — пересобрать `getExtractorPrompt`:
  - Жёсткий cap: ≤3 `memory_write` на exchange (если больше — уверен только в первых 3).
  - Pre-write thinking step required: «прежде чем write, вызови `memory_search` с query из candidate-facts; если cosine ≥0.92 — пропусти, ничего не пиши; если supersedes — write с `supersedes_id`».
  - Phrase «лучше не писать, чем написать мусор» — explicit.
  - DO-NOT-SAVE list (расширить current blacklist): «temporary state», «in-progress task IDs», «tool execution timestamps», «debug logs».

**Tests:**
- `tests/hippocampus-extraction.test.ts` — обновить ожидания на ≤3 writes/exchange, dedup-aware.

**Acceptance:**
- Manual review: 24h после deploy → 90%+ writes по whitelist + non-trivial cosine distance к existing.

---

### PR-E — Teamlead + memory character (final pass, low risk)

**Цель:** дать synthesis (teamlead) и hippocampus (memory) персональность + verification clause без потери функции. Бьёт R7.

**Files:**
- [src/pipeline/arbitration/prompts.ts](../../src/pipeline/arbitration/prompts.ts) — `buildSynthesisSystemPrompt`:
  - Персональность: «Ты — рассудительный тимлид. Не угождаешь, не льстишь. Если specialists ошибаются — называй это прямо. Объясняешь WHY.» (адаптация из leaked CC system prompt).
  - Verification clause: «прежде чем merge consensus, проверь — нет ли тривиального counter-example. Если specialist N hedges ("вероятно", "возможно") — не присваивай его голосу полный вес.»
- [src/pipeline/agent-pipeline/post/prompt.ts](../../src/pipeline/agent-pipeline/post/prompt.ts) — добавить тон memory-агента: «ты — гиппокамп юзера. Записываешь только то, что surprising / non-obvious / actionable. Скучные факты не сохраняются — забываются.»

Никаких behavior-changes — только текст промтов. Покрыто existing tests.

**Acceptance:**
- All existing tests pass без изменений (purely textual).
- Manual qual review: synthesis output noticeably less wishy-washy.

---

## Order of execution

Строго последовательно — каждый PR зависит от предыдущего.

1. **PR-A** (schema + dedup + TTL) — **критический**. Остальное зависит от write-discipline + on-write dedup helper.
2. **PR-B** (janitor + one-time sweep) — heavy batch cleanup. Запустить ДО PR-C, чтобы legacy переехал в archive до того, как `clear` task-type будет дёргать инкрементально.
3. **PR-C** (agent-pool) — использует `done_with_artifact` (новый tool) + validators (PR-A) + предполагает чистую memory base (PR-B уже убрал legacy).
4. **PR-D** (hippocampus prompt) — после A для whitelist enforcement, независимо от C/B.
5. **PR-E** (character prompts) — последним, low risk, чисто текстовые.

**Cleanup responsibility split** (важно):
- **PR-B janitor** = тяжёлая batch ночью (expired, dedup pass по всей таблице, legacy sweep one-time, task `tasks` table).
- **PR-C/clear runner** = лёгкая инкрементальная (одна (layer,category) пара за тик, дополняет nightly не заменяет).
- **PR-A on-write dedup** = ingest-time, не позволяет дубликатам появиться вообще.
- Не пытаемся консолидировать в одно — три уровня по разной частоте/нагрузке.

## Risks + mitigation

| Risk | Mitigation |
|------|-----------|
| PR-A break существующий free-agent на legacy categories | One-time prod sweep (PR-B Phase C) переносит legacy в archive до того, как validators начнут reject. Deploy A+B вместе. |
| Dedup cosine threshold слишком агрессивен → теряем валидные facts | `JANITOR_DEDUP_THRESHOLD` env, default 0.92. Можно поднять до 0.95 если ложных дедупов. |
| `done_with_artifact` ломает existing autonomous scheduler | Старый `done` остаётся (dynamic_tools видит оба); free-agent prompt prefers new tool. |
| Free-agent rewrite — слишком жёсткий, агент стопорится на «нет артефакта» | Anti-idle break + `noop` с reason — agent всегда может exit gracefully. |
| Personality в teamlead меняет synthesis output → ломает downstream parsers | Никакой downstream не парсит synthesis text как structured — только finalAnswer string. Низкий риск. |

## Premortem (план провалился через 3 мес — почему?)

Представь: 2026-08-03. Юзер открывает `/memory` страницу — снова мусор. Free-agent в TG молчит неделю. Что пошло не так?

### Fail mode 1: Whitelist оказался слишком узким
**Сценарий:** Через месяц после PR-A агент пытается записать valid факт, validators reject ("category not in whitelist"). Агент сдаётся (не пытается в другой category) ИЛИ начинает spam'ить разрешённые категории неуместными фактами.
**Probability:** средняя.
**Mitigation:**
- В hippocampus prompt'е (PR-D) явно показать: «если ни одна whitelist-category не подходит — НЕ пиши, сообщи `done` со statement о том что забыл».
- Telemetry: `memory_write_rejected_total` counter с `reason` label, alert если >20% writes reject'аются за час.
- Whitelist расширяется только через explicit PR + audit-log entry, не silent edit.

### Fail mode 2: On-write dedup затыкает legitimate обновления
**Сценарий:** Юзер сменил предпочтение («раньше любил X, теперь Y»). Cosine 0.93 к старому факту → reject как duplicate. Старая инфа остаётся, новая теряется.
**Probability:** высокая (главный риск).
**Mitigation:**
- Threshold 0.92 — для `category=preference/goal` понижаем до 0.85, или: при cosine ≥0.92 НЕ reject, а помечаем `supersedes_id` + soft-archive старого.
- Алгоритм: cosine ≥0.95 = true dup (reject), 0.85-0.95 = supersede (overwrite), <0.85 = fresh.
- В PR-A явно: для категорий `preference/goal/relationship/style/constraint` (динамичные) — supersede mode дефолт; для `profile/skill/architecture` (стабильные) — strict reject mode.

### Fail mode 3: Agent-pool zombie-tasks
**Сценарий:** Task стартанул, runner упал (LLM timeout, browser crash), `status='running'` навсегда. Pool depth растёт, но claim никогда не возвращает их → пустые тики → `find-new-task` спамит дубликатами.
**Probability:** высокая (любой long-running pool страдает).
**Mitigation:**
- `running` task с `started_at < now()-30min` → автоматически `status='failed'` + `reason='timeout'` при следующем pool-tick.
- Per-task heartbeat? Нет — overkill. Достаточно timeout.
- `find-new-task` перед enqueue делает `memory_search` по prompt-снippet — не дублирует если такая же уже pending/running/recently-done (последние 24h).

### Fail mode 4: Free-agent выбирает только D2 (research) — никаких D1/D3/D4
**Сценарий:** Research-задачи самые «безопасные» (read-only web + memory_write). Агент LLM-обучен предпочитать low-risk → 95% запусков = research, 0% = world-tasks/PR/code-tools. Юзер видит только «извлёк 2 факта», никаких real-world артефактов.
**Probability:** высокая (LLM bias к safe actions).
**Mitigation:**
- Pool-level type quotas: за rolling 24h ≥30% complete-tasks должны быть type ≠ `research`. Если skew → `find-new-task` принудительно enqueue D1/D3 prompt.
- Free-runner prompt: «приоритет D1 > D3 > D4 > D2. Research — fallback, не дефолт».
- TG digest формат показывает type-distribution: «За день: 8 research / 1 free-D1 / 0 free-D3» — юзер сразу видит skew.

### Fail mode 5: Night janitor (PR-B) удалил нужные facts
**Сценарий:** Legacy sweep one-time прошёл, переехало 3000 rows в archive. Через 2 недели юзер задаёт вопрос → агент не знает важную деталь → копаемся → нашли в archive. Trust в системе упал.
**Probability:** средняя.
**Mitigation:**
- One-time sweep ВСЕГДА требует TG-confirm с counter («about to archive 3142 rows. Sample preview: …»). YES от юзера обязательно.
- Archive — не delete. Restoration: добавить `POST /v1/memory/restore?layer=archive&id=N` endpoint в PR-B.
- Sample-preview показывает 5 случайных rows из тех что будут переехан — юзер ловит обвал заранее.

### Fail mode 6: Anti-economy → бесконтрольный $$ / RPM crash
**Сценарий:** Я написал «не экономь токены» — агент тратит 50k tokens на тривиальную задачу. NVIDIA RPM упирается в потолок, основные чаты юзера тормозят.
**Probability:** низкая (NVIDIA лимиты бесплатные но RPM ≠ ∞).
**Mitigation:**
- `router.isOverloaded` уже есть — pool пропускает тики. Никогда не кладёт RPM на чат.
- Per-runner `maxSteps` всё ещё есть как safety ceiling (default 50, не уменьшать).
- Cost telemetry: `agent_pool_tokens_total` по типу runner. Если research-runner внезапно жрёт 100k/тик — bug, не feature.

### Fail mode 7: Hippocampus стал слишком осторожным → ничего не пишет
**Сценарий:** PR-D prompt «лучше не писать чем мусор» интернализован LLM-ом → 90% exchanges заканчиваются 0 writes. Memory не растёт. Через 2 мес `shared` имеет 50 rows, RAG бесполезен.
**Probability:** средняя.
**Mitigation:**
- Prompt балансировка: «лучше не писать мусор, НО — каждое 3-е сообщение юзера содержит хоть один artefact-worthy факт. Если ты ничего не нашёл за 3 exchanges подряд — ты слишком осторожен».
- Telemetry: `hippocampus_writes_per_exchange` rolling avg. Если <0.3 за неделю → alert.
- A/B fallback: если hippocampus вернул 0 writes 5 раз подряд — следующий exchange использует более «liberal» prompt с lower bar.

### Fail mode 8: PR-C потребовал больше работы чем оценено
**Сценарий:** Новая `agent_tasks` table, repo-layer, 5 runners, claim atomicity, find-new-task gate, parallel concurrency — это 2 недели работы, не PR. Прерывается посередине. На prod часть кода без integration → ничего не работает.
**Probability:** высокая.
**Mitigation:**
- PR-C декомпозируется ДО стартa: PR-C1 (table + repo), PR-C2 (single-runner pool, only `free` type), PR-C3 (multi-type runners), PR-C4 (parallel concurrency + find-new-task). Каждый mergeable independently, prod работает после каждого.
- Если на C2 видно что не успеваем — стопаем там, free-agent old удаляем, single-runner pool в prod на месяц, потом продолжаем.

### Fail mode 9: Юзер устал от TG digest spam
**Сценарий:** Pool гонит 20 тасков/день, каждый — TG-сообщение. Юзер mute'ит бот → пропускает важные.
**Probability:** средняя.
**Mitigation:**
- Один daily digest вечером (e.g. 21:00 local) с summary всех tasks за день, не per-task.
- Real-time alert ТОЛЬКО для: failed task, complete D3/D4 (real-world action), check-tg unread с keyword юзера.
- `/digest_mode quiet|verbose` команда в боте.

### Severity-ranked top-3 (фокус mitigation):

1. **Fail mode 2 (on-write dedup на legit updates)** — конкретный фикс в PR-A: per-category supersede vs strict mode.
2. **Fail mode 4 (skew к research)** — фикс в PR-C: type-quota + find-new-task force-balance.
3. **Fail mode 8 (PR-C overscoping)** — декомпозиция на C1-C4 ДО старта.

## Out of scope (для будущих spec)

- Cross-session memory consolidation (Mem0-style mark-invalid).
- Embedding-based clustering для shared (A-Mem zettelkasten).
- Replace `memory.service.ts` legacy paths.
- ClawHub-style external skill registry.

## Open questions (для юзера перед `/task` handoff)

1. **TTL granularity** — `context/project/bug` = 30d default. Не агрессивно? Альтернатива: 60d с явным `expires_at` от агента для коротких.
2. **Legacy sweep mode** — env-flag `JANITOR_LEGACY_SWEEP=true` + TG-prompt «about to archive N rows, ok? [reply YES]» перед действием? Или fully automated? (lean — TG-prompt для one-time, потом автомат для свежих.)
3. **`maxConcurrent`** для agent-pool — старт с 2 или 3? NVIDIA RPM зависит от текущей nагрузки чатов, лучше adaptive (`min(3, freeRpm/expectedRunCost)`).
4. **`find-new-task` cooldown** — 10 мин достаточно, или гибче (e.g. exponential если pool пустеет несколько тиков подряд)?
5. **`check-tg` scope** — какие TG-чаты watch'ить? Конфиг env var `CHECK_TG_WATCHLIST=chat_id1,chat_id2` или auto-detect по unread? (lean — env list для предсказуемости.)
