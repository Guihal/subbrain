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
  - Cosine ≥ 0.92 → `ToolError{code:"duplicate", message:"superseded by id=X"}` (агент видит и переносит дальше).
  - Cosine 0.85-0.92 → insert + `supersedes_id` link на ближайшего.
  - Cosine < 0.85 → fresh insert.
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

**Concurrency:**
- `maxConcurrent` env, default `2`. Поднять до 3 если NVIDIA RPM headroom (router exposes `freeRpm()`).
- Pool runner проверяет `router.isOverloaded` перед claim — если true, пропускает тик.
- Per-type rate limit: `check-tg` — max 1 раз в 5 мин; `clear` — max 1 параллельно (DB-write contention); `free`/`research` — без ограничений сверх `maxConcurrent`.

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
