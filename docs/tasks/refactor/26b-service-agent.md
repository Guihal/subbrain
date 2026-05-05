# Задача 26b — Service слой: Agent (LAYER-4)

**Оценка:** 1 день
**Зависимости:** 21, 26a
**Status:** DONE (PR 26b)

## Цель

Обернуть `AgentLoop` в `AgentService`, так чтобы:
- `routes/autonomous.ts`,
- `scheduler/autonomous.ts`,
- `scheduler/free-agent.ts`

дёргали сервис (`AgentService.run({mode, prompt, ...})`), а не конструировали AgentLoop вручную. Scheduled-mode дисциплина (PR 21) инкапсулирована в сервисе.

## Файлы

- [packages/agent/src/services/agent.service.ts](../../../packages/agent/src/services/agent.service.ts) — новый.
- [packages/server/src/routes/autonomous.ts](../../../packages/server/src/routes/autonomous.ts) — thin.
- [packages/agent/src/scheduler/autonomous.ts](../../../packages/agent/src/scheduler/autonomous.ts), [free-agent.ts](../../../packages/agent/src/scheduler/free-agent.ts) — через `agentService.run`.
- [packages/server/src/app/deps.ts](../../../packages/server/src/app/deps.ts) — инстанцирует `AgentService`.

## Изменение

### 1. `packages/agent/src/services/agent.service.ts`

```
interface AgentRunOpts {
  task: string;
  agentMode: "scheduled" | "interactive";
  model?: string;          // default "teamlead"
  priority?: Priority;     // default "low"
  maxSteps?: number;
  signal?: AbortSignal;
}

class AgentService {
  constructor(
    private agentLoop: AgentLoop,
    private memory: MemoryDB,
  ) {}

  async run(opts: AgentRunOpts): Promise<AgentRunResult>;
  createStream(opts: AgentRunOpts): AsyncIterable<AgentStreamEvent>;
}
```

Внутри: вызывает `this.agentLoop.run({...opts})`. Пробрасывает `agentMode` в AgentLoop (параметр из PR 21).

### 2. Entrypoints

```
// routes/autonomous.ts
export function autonomousRoute(agentService: AgentService, memory: MemoryDB) {
  return new Elysia().post("/v1/autonomous", async ({ body }) => {
    const result = await agentService.run({
      task: body.task,
      agentMode: "interactive",
      maxSteps: body.max_steps ?? 12,
    });
    return result;
  }, { body: AutonomousRequestSchema });
}

// scheduler/autonomous.ts
await agentService.run({
  task: buildScheduledPrompt(),
  agentMode: "scheduled",
  maxSteps: parseInt(process.env.AUTONOMOUS_MAX_STEPS ?? "100", 10),
});

// scheduler/free-agent.ts
await agentService.run({
  task: process.env.FREE_AGENT_TASK ?? DEFAULT_FREE_AGENT_TASK,
  agentMode: "scheduled",
  maxSteps: parseInt(process.env.FREE_AGENT_MAX_STEPS ?? "50", 10),
});
```

### 3. `deps.ts`

```
const agentService = new AgentService(agentLoop, memory);
```

## Тесты

`tests/agent-service.test.ts`:

- Unit mock AgentLoop. `agentService.run({agentMode: "scheduled", task: "X"})` вызывает `agentLoop.run` с `agentMode: "scheduled"` в options.
- `createStream` возвращает async iterable.

`tests/scheduler-regression.test.ts`:

- Spawn autonomous scheduler с mock deps. Assert что в tick вызывается `agentService.run({agentMode: "scheduled"})`.
- То же для free-agent.

## Приёмка

- [ ] `bunx tsc --noEmit` = 0.
- [ ] Оба теста зелёные.
- [ ] `grep -rn 'new AgentLoop\b' src/` — матчится только в `services/agent.service.ts` либо в `deps.ts`.
- [ ] `routes/autonomous.ts` < 60 LoC.
- [ ] `scheduler/autonomous.ts`, `scheduler/free-agent.ts` не дёргают AgentLoop напрямую.
- [ ] LAYER-4 вычеркнут в [docs/02-audit.md](../../02-audit.md).

## Deploy note

```bash
ssh root@109.120.187.244
cd /opt/subbrain
git pull
docker compose build && docker compose up -d
docker compose logs -f | grep -E 'autonomous|free-agent'
```
