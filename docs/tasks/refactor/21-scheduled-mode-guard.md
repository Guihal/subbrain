# Задача 21 — Scheduled-mode guard для code tools (SCHED-1)

**Оценка:** 3–4 часа
**Зависимости:** —
**Status:** DONE (PR #21)

## Цель

Автономный агент получает право создавать и редактировать исполняемый код без человеческого approval. Это опасно при запуске из расписания: никто не смотрит в момент выполнения.

Проблемные точки:

- [packages/agent/src/pipeline/agent-loop/system-prompt.ts:167-184](../../../packages/agent/src/pipeline/agent-loop/system-prompt.ts#L167-L184) — промпт явно предлагает модели звать `create_code_tool` и писать TypeScript с `fetch()` доступом к любым API.
- [packages/agent/src/pipeline/agent-loop/code-tools/sandbox.ts:1-14](../../../packages/agent/src/pipeline/agent-loop/code-tools/sandbox.ts#L1-L14) — сам комментарий признаёт: «Not a hard security boundary. Hostile code can still escape via regex-bypass obfuscation ... or any Bun Worker global we haven't nuked.»
- Entrypoints, запускающие агент без человека в цикле:
  - `packages/agent/src/scheduler/autonomous.ts` — AUTONOMOUS loop
  - `packages/agent/src/scheduler/free-agent.ts` — free-agent loop
  - `src/night-cycle/*` — если вызывает AgentLoop внутри (проверить; post/hippocampus вызывает `AgentPipeline` с маленьким tool-кругом, но всё равно зона риска)

Интерактивный `POST /v1/autonomous` (routes/autonomous.ts) — триггерится человеком, сохраняем полный доступ.

## Файлы

- [packages/agent/src/pipeline/agent-loop/run.ts](../../../packages/agent/src/pipeline/agent-loop/run.ts), [stream.ts](../../../packages/agent/src/pipeline/agent-loop/stream.ts), [types.ts](../../../packages/agent/src/pipeline/agent-loop/types.ts) — `agentMode: "scheduled" | "interactive"` в `RunOptions`.
- [packages/agent/src/mcp/registry/index.ts](../../../packages/agent/src/mcp/registry/index.ts) (или `tool-registry.ts`) — `listForAgent(mode)`.
- [packages/agent/src/pipeline/agent-loop/system-prompt.ts](../../../packages/agent/src/pipeline/agent-loop/system-prompt.ts) — секция про code tools условная.
- [packages/agent/src/scheduler/autonomous.ts](../../../packages/agent/src/scheduler/autonomous.ts), [packages/agent/src/scheduler/free-agent.ts](../../../packages/agent/src/scheduler/free-agent.ts) — передают `agentMode: "scheduled"`.
- [packages/server/src/routes/autonomous.ts](../../../packages/server/src/routes/autonomous.ts) — передаёт `agentMode: "interactive"`.
- [src/night-cycle/](../../../src/night-cycle/) — ревизия; если вызывает AgentLoop — `scheduled`.

## Изменение

### 1. `AgentLoop.run / createStream` — новый параметр

```
interface RunOptions {
  ...
  agentMode?: "scheduled" | "interactive";  // default "interactive"
}
```

`agentMode` пробрасывается в `buildSystemPrompt()` и в `registry.listForAgent(mode)`.

### 2. `registry.listForAgent(mode)`

Новый метод на ToolRegistry — возвращает список tool-defs, отфильтрованный под mode.

- `"interactive"` → все agent-only тулы как сейчас.
- `"scheduled"` → скрыть:
  - `create_tool`
  - `create_code_tool`
  - `edit_code_tool`
- Существующие динамически созданные тулы (через `dynamicTools`) и `code_*` (через `codeTools`) **остаются доступными** — удаление/modification запрещены, но использование — ок (D5).

### 3. `system-prompt.ts` — условная секция

Секция «### 🔧 Code Tools (исполняемый код):» и всё под ней → рендерится **только если mode === "interactive"**.

Под scheduled — короткая заметка: «Code tools creation disabled in scheduled mode. Use existing tools only.»

### 4. Entrypoints

| Entrypoint | Mode |
|---|---|
| `scheduler/autonomous.ts` (AUTONOMOUS loop) | `scheduled` |
| `scheduler/free-agent.ts` | `scheduled` |
| `routes/autonomous.ts` (`POST /v1/autonomous`) | `interactive` |
| `night-cycle/*` (если dispatches AgentLoop) | `scheduled` |
| Interactive chat (routes/chat.ts pipeline mode) | не использует AgentLoop напрямую — игнорируется |

**Проверка night-cycle:** `src/night-cycle/` не импортирует `AgentLoop` напрямую — night-cycle pipeline самостоятельный (PII-scrub / translate / compress / verify / dedup через `router.chat` без tools). Если через `post/hippocampus` вызывается с `scheduled` mode — OK.

### 5. Env override

`SCHEDULED_ALLOW_CODE_TOOL_CREATE=1` — runtime opt-in. Если set, `listForAgent("scheduled")` ведёт себя как `"interactive"` в части create/edit tools. Задокументировать в CLAUDE.md как opt-in для ручных сценариев, **не включать по умолчанию**.

## Тесты

`tests/scheduled-mode-registry.test.ts`:

- `registry.listForAgent("interactive")` содержит `create_tool`, `create_code_tool`, `edit_code_tool`.
- `registry.listForAgent("scheduled")` НЕ содержит ни один из трёх.
- С `SCHEDULED_ALLOW_CODE_TOOL_CREATE=1` — `"scheduled"` возвращает то же что `"interactive"`.

`tests/system-prompt-mode.test.ts`:

- `buildSystemPrompt({..., agentMode: "scheduled"})` — output НЕ содержит `create_code_tool`, содержит disable-заметку.
- `buildSystemPrompt({..., agentMode: "interactive"})` — содержит.

`tests/scheduler-mode.test.ts` (mock):

- Spawn `autonomousScheduler` с mock AgentLoop. Вызов `agentLoop.run` получает `agentMode: "scheduled"` в options.
- То же для `freeAgent`.

## Приёмка

- [ ] `bunx tsc --noEmit` = 0.
- [ ] Все новые тесты зелёные.
- [ ] `grep -n 'agentMode' packages/agent/src/scheduler/*.ts packages/server/src/routes/autonomous.ts` показывает явное значение в каждом entrypoint.
- [ ] `grep -rn 'create_code_tool' packages/agent/src/pipeline/agent-loop/system-prompt.ts` — присутствует только внутри условного блока.
- [ ] SCHED-1 вычеркнут в [docs/02-audit.md](../../02-audit.md).

## Deploy note

```bash
ssh root@109.120.187.244
cd /opt/subbrain
git pull
docker compose build && docker compose up -d
```

## Follow-ups

- `code_*` (существующие) доступные в scheduled — если обнаружится что конкретный существующий тул был опасен при ручном approval (например `code_exec_shell`), его можно помечать `scheduledEnabled: false` через metadata (вне рамок PR).
- Approval-workflow через TG («агент просит разрешения на create_code_tool») — отдельная feature, не security baseline.
