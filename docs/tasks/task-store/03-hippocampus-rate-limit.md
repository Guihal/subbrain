# Phase 3 — Hippocampus rule + taskMutationBudget

**Complexity:** standard. **Estimate:** 0.2 day.
**Depends on:** Phase 1 done (tasks tools registered), Phase 2 done (system-prompt injection).
**Trigger:** `/task --depth=standard <весь этот файл как prompt>`.

## Цель

Hippocampus (post-processing агент в `packages/agent/packages/agent/packages/agent/packages/agent/src/pipeline/agent-pipeline/post/hippocampus.ts`) сейчас умеет `memory_search`/`memory_write`/`done`. Нужно научить его использовать `task_add` вместо `memory_write` для lifecycle items (TODO/reminder/deadline) и поставить rate-limit на все `task_*` мутации чтобы отсечь spam-галлюцинации.

## Проблема которую решаем

Сейчас hippocampus записывает задачи в `shared_memory` вперемешку с фактами. На следующем цикле executive-summary достаёт эти строки и агент думает что "задача X ещё не сделана" → галлюцинация о закрытых тасках. Решение: разделить память (immutable facts) и tasks (mutable lifecycle), hippocampus пишет задачи через `task_add` (scope="global"), память только для фактов.

## Scope

### 1. Update system-prompt в hippocampus

`packages/agent/packages/agent/packages/agent/packages/agent/src/pipeline/agent-pipeline/post/hippocampus.ts` (или `post/extractors.ts` если prompt вынесен). Найти функцию типа `getExtractorPrompt()` или inline system-prompt. Добавить в конец секцию:

```
Три стора — не смешивай:

- `shared_memory`/`layer2_context` — immutable facts (кто пользователь, паттерны, архитектура, предпочтения).
- `tasks` — lifecycle state (TODO, reminders, deadlines, action items).
- `scheduler_state` — ephemeral runtime flags (НЕ трогай).

Правила:
- Если в разговоре задача/TODO/reminder/deadline → `task_add({scope:"global", title, description?, due_at?})`.
- Если факт о пользователе/проекте/стеке → `memory_write`.
- Если не уверен — предпочти `task_add`. False-positive в tasks безопасен (LLM закроет через `task_done`). False-negative в memory засоряет shared навсегда.

Бюджет мутаций — 3 на exchange (add+update+start+done+cancel суммарно). 4-й вернёт `rate_limit` — заверши или отложи.
```

### 2. Добавить task_add в allowed tools hippocampus

Найти где MAX_HIPPO_STEPS=5 и список tools формируется. Файлы: `packages/agent/packages/agent/packages/agent/packages/agent/src/pipeline/agent-pipeline/post/hippocampus.ts`, `post/extractors.ts`, `post/gate.ts`. Список tools обычно фильтруется по именам или scope. Добавить `task_add` в allow-list (но **не** весь `task_*` — hippocampus не должен мутировать чужие задачи).

Проверить: если hippocampus использует `registry.toOpenAITools("public")` — тогда `task_add` не попадёт потому что scope="agent-only". Нужно либо:
- Вариант A: разрешить в hippocampus весь agent-only scope (проверить side-effects — может задеть `done`/`consult_*`).
- Вариант B: создать узкий whitelist типа `const HIPPO_TOOLS = ["memory_search", "memory_write", "task_add", "done"]` и фильтровать `registry.list().filter(t => HIPPO_TOOLS.includes(t.name))`.

Предпочтительно **Вариант B** — контроль явный, сохраняем scope="agent-only" для task_add вне hippocampus.

### 3. taskMutationBudget в AgentContext

**File:** `packages/agent/packages/agent/packages/agent/packages/agent/src/pipeline/agent-loop/types.ts` или там где объявлен AgentContext. Если есть `AgentContext` interface — добавить:

```ts
export interface TaskMutationBudget {
  remaining: number;
}
```

**File:** `packages/agent/packages/agent/packages/agent/src/mcp/registry/tool-registry.ts` — в `ToolContext` добавить:

```ts
export interface ToolContext {
  // ...existing fields...
  taskBudget?: TaskMutationBudget;
}
```

**File:** `packages/agent/packages/agent/packages/agent/src/mcp/registry/tasks.tools.ts` — в каждом из 6 task_* handlers перед `ctx.executor.tasksTools.<action>(args)` вставить guard:

```ts
handler: (args, ctx) => {
  if (ctx.taskBudget) {
    if (ctx.taskBudget.remaining <= 0) {
      return {
        success: false,
        error: "rate_limit: task mutation budget (3) spent for this exchange; finish or defer",
      };
    }
    ctx.taskBudget.remaining -= 1;
  }
  return ctx.executor.tasksTools.add(args);
}
```

`taskBudget` populates только в hippocampus path — нормальный agent-loop (agent_loop/step.ts) НЕ ставит budget (там своя mechanics MAX_STEPS). Budget=undefined → guard пропускает.

### 4. Wire budget в hippocampus вызовах

**File:** `packages/agent/packages/agent/packages/agent/packages/agent/src/pipeline/agent-pipeline/post/hippocampus.ts`. Где создаётся ctx для registry.call — передать `taskBudget: {remaining: 3}` в объект ctx. Budget создаётся один раз на entry hippocampus-loop и переиспользуется между tool calls. Если hippocampus-loop делает несколько registry.call — один и тот же объект (shared reference), `remaining` мутируется.

Critical: если hippocampus-loop работает через agent-loop/run.ts (не direct registry.call) — нужно пробросить `taskBudget` через `ToolRunnerDeps` и далее в `ctx` в executeAgentTool. Проверить архитектуру.

### 5. Tests

`tests/hippocampus-task-budget.test.ts` (new):
- In-memory MemoryDB + mock ToolRegistry (или реальный).
- Создать ToolContext с `taskBudget: {remaining: 3}`.
- Вызвать `registry.call("task_add", args, ctx)` 3 раза — все success.
- 4-й раз → `{success:false, error:"rate_limit: ..."}`.
- budget.remaining после 3 вызовов = 0.
- `task_add` без budget в ctx (undefined) → всегда success (регрессия не в non-hippo path).
- `task_update`/`task_done`/`task_cancel`/`task_start` тоже расходуют тот же budget (симметрия).

## Edge cases

- Race: одновременные tool calls от одного agent — budget в JS мутируется синхронно, нет race в single-threaded bun runtime.
- Retry: если hippocampus-loop рестартует с тем же ctx (крайне редко) — budget продолжается, не сбрасывается. Это правильно (защита от retry-amplified spam).
- `task_list` — **не** мутация, не расходует budget.

## Verify

```bash
bunx tsc --noEmit     # exit 0
bun test tests/hippocampus-task-budget.test.ts
bun test              # full suite, ожидаем ~315+ pass
```

## Out of scope

- Phase 4 TG reliability (идёт следом).
- Изменение MAX_HIPPO_STEPS=5.
- Миграция существующих shared_memory записей-тасков (Phase 5 `migrate-tasks-from-memory.ts`).

## Guardrails reminder

- `packages/agent/packages/agent/packages/agent/packages/agent/src/pipeline/agent-pipeline/post/hippocampus.ts` — file cap 250. Если >230 — не добавляй много кода, вынеси в helpers.
- `logger.child("hippocampus")` — двухаргументный уже root, child — single.
- Tests через `bun:test` describe/test/expect; не top-level `process.exit`.

## Что изменяется в git

Новые: `tests/hippocampus-task-budget.test.ts`.
Modified: `packages/agent/packages/agent/packages/agent/packages/agent/src/pipeline/agent-pipeline/post/hippocampus.ts`, `packages/agent/packages/agent/packages/agent/src/mcp/registry/tasks.tools.ts`, `packages/agent/packages/agent/packages/agent/src/mcp/registry/tool-registry.ts` (+ `AgentContext` types если они где-то централизованы).

## После завершения

Запиши краткий итог в `~/vault/RLM/Daily/YYYY-MM-DD.md` (RLM skill делает это автоматом). В next task-файле (Phase 4) уже можно ссылаться "Phase 3 готова, budget работает".
