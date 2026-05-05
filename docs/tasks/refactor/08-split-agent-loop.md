# Задача 08 — Splitting `agent-loop/index.ts`

**Оценка:** 1 день
**Зависимости:** после PR 01 (tool timeout) и PR 02 (signal/abort инфраструктура)
**Status:** DONE

## Цель

[packages/agent/packages/agent/packages/agent/src/pipeline/agent-loop/index.ts](../../../packages/agent/packages/agent/packages/agent/src/pipeline/agent-loop/index.ts) (~625 строк) совмещает оркестрацию, шаг, диспатч tool_calls, SSE-heartbeat, hook компрессора и обвязку. Разнести по одной ответственности на файл, сам `index.ts` оставить ≤80 строк фасадом.

## Целевая структура

Внутри той же папки `packages/agent/packages/agent/src/pipeline/agent-loop/`:

```
agent-loop/
├── index.ts            # ≤80: фасад AgentLoop (run, createStream)
├── run.ts              # run() (non-stream) + createStream() — общий step-loop
├── step.ts             # один step: ModelRouter call → parse tool_calls → dispatch → собрать messages
├── tool-dispatch.ts    # нормализация tool_calls (OpenAI vs Anthropic flavor) + tool-runner вызов + сборка tool_result
├── heartbeat.ts        # SSE heartbeat + idleTimeout guards
├── compressor-hook.ts  # вызов context-compressor перед каждым step
├── tool-runner.ts      # уже есть, оставить
├── system-prompt.ts    # уже есть, не трогать
├── types.ts            # уже есть
└── code-tools/         # уже есть, не трогать
```

## Что куда

### `index.ts` (фасад)
```ts
export class AgentLoop {
  constructor(private deps: AgentLoopDeps) {}

  async run(opts: RunOpts): Promise<RunResult> {
    return runLoop(this.deps, opts);
  }

  createStream(opts: RunOpts): ReadableStream<Uint8Array> {
    return runStreamLoop(this.deps, opts);
  }
}
```

### `run.ts`
- `runLoop(deps, opts) → RunResult` — non-stream, возвращает финальный assistant + use-info.
- `runStreamLoop(deps, opts) → ReadableStream` — обёртка над тем же step-loop, эмитит SSE chunks через `heartbeat.ts`.
- Цикл: пока `step < MAX_STEPS` (= 100, из `types.ts`) и нет `done`-сигнала → `compressMessagesIfNeeded()` → `executeStep()` → ...

### `step.ts`
- `executeStep(deps, state) → StepResult` — один шаг:
  1. `ModelRouter.chat(messages, tools)` — учитывая signal.
  2. Если в response есть `tool_calls` → `dispatchToolCalls()` (см. ниже).
  3. Если plain text → завершить (`done: true, text: ...`).
  4. Если `tool_calls.find(c => c.name === "done")` → завершить, `text: tool_args.data` (агент явно сказал «всё»).
  5. Иначе — записать `tool_result` сообщения и вернуть `{done: false, newMessages}`.

### `tool-dispatch.ts`
- `dispatchToolCalls(calls, deps) → ToolResultMessage[]`:
  - Нормализация: OpenAI emits `tool_calls: [{id, function: {name, arguments}}]`; Anthropic emits `[{type: "tool_use", id, name, input}]`. Привести к общему `NormalizedCall`.
  - Параллельный вызов `toolRunner.run(call)` (учитывая per-tool timeout из PR 01 HIGH-3).
  - Сборка `{role: "tool", tool_call_id, content: JSON.stringify(result)}`.

### `heartbeat.ts`
- `setupHeartbeat(controller: ReadableStreamDefaultController): { stop: () => void }` — `setInterval(() => controller.enqueue(": ping\n\n"), 5000)`.
- `stop()` обязан вызываться в `finally` цикла (иначе ping продолжается после close).

### `compressor-hook.ts`
- `maybeCompress(messages: Message[]): boolean` — обёртка над `context-compressor.ts`, возвращает `true` если сжали (для логирования).
- Вызывается в начале каждого step.

## Риски

- Циклические импорты: `index.ts` → `run.ts` → `step.ts` → `tool-dispatch.ts` → `tool-runner.ts`. Линейная цепочка, проблем не должно быть.
- Закрытое состояние loop (счётчик step, accumulator messages) — передавать как параметр объекта `state: AgentLoopState`, не глобалкой.
- Тесты на `AgentLoop` уже есть — должны зеленеть как чёрный ящик.

## Тесты

- `tests/agent-loop-step.test.ts` (новый) — изоляция: mock-`ModelRouter` возвращает один `tool_call` → `executeStep` делает ровно один tool вызов, корректные `tool_result` сообщения.
- `tests/agent-loop-dispatch.test.ts` (новый) — сравнение OpenAI flavor vs Anthropic flavor → одинаковый `NormalizedCall[]`.
- Существующие `tests/agent-loop.test.ts` — все продолжают зеленеть.

## Файлы

- [packages/agent/packages/agent/packages/agent/src/pipeline/agent-loop/index.ts](../../../packages/agent/packages/agent/packages/agent/src/pipeline/agent-loop/index.ts) (сократить)
- `packages/agent/packages/agent/packages/agent/packages/agent/src/pipeline/agent-loop/run.ts` (новый)
- `packages/agent/packages/agent/packages/agent/packages/agent/src/pipeline/agent-loop/step.ts` (новый)
- `packages/agent/packages/agent/packages/agent/packages/agent/src/pipeline/agent-loop/tool-dispatch.ts` (новый)
- `packages/agent/packages/agent/packages/agent/packages/agent/src/pipeline/agent-loop/heartbeat.ts` (новый)
- `packages/agent/packages/agent/packages/agent/packages/agent/src/pipeline/agent-loop/compressor-hook.ts` (новый)
- `tests/agent-loop-step.test.ts`, `tests/agent-loop-dispatch.test.ts`
- [CLAUDE.md](../../../CLAUDE.md) — обновить пути в секции «Pipelines fan out…».

## Порядок исполнения

1. Вынести `heartbeat.ts` (изолированный helper).
2. Вынести `compressor-hook.ts` (тоже изолирован).
3. Вынести `tool-dispatch.ts` + тесты на нормализацию.
4. Вынести `step.ts` + тесты.
5. Вынести `run.ts` (объединяет 1-4).
6. Сократить `index.ts` до фасада.
7. Прогон полного `bun test` после каждого шага — ловит регрессию рано.

## Приёмка

- [ ] `bunx tsc --noEmit` = 0.
- [ ] `bun test` зелёные (≥80).
- [ ] `wc -l packages/agent/packages/agent/packages/agent/src/pipeline/agent-loop/index.ts` ≤ 80.
- [ ] Все файлы в `agent-loop/` ≤ 250 строк.
- [ ] `bun run tests/integration.live.ts` end-to-end проходит, autonomous-loop работает.
