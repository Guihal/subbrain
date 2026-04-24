# Задача 20 — AbortSignal пробрасывается сквозь timeout (CANCEL-1)

**Оценка:** 4–6 часов
**Зависимости:** —
**Status:** DONE (PR 20)

## Цель

`Promise.race([exec, timeout])` даёт ложное чувство контроля: когда timeout побеждает, underlying fetch / LLM-stream / browser-step продолжает работать в фоне до естественного конца. Память/RPM/процессорные секунды сливаются на работу, результат которой никому не нужен.

Два места:

- [src/pipeline/agent-loop/tool-runner.ts:45-65](../../../src/pipeline/agent-loop/tool-runner.ts#L45-L65) — `withToolTimeout` делает race, но не abort.
- [src/pipeline/arbitration-room.ts:85,225-249](../../../src/pipeline/arbitration-room.ts#L85) — `controllers[i]` создаются, **но `timer = setTimeout(() => reject(...))` не вызывает `abort()`**.

## Файлы

- [src/pipeline/agent-loop/tool-runner.ts](../../../src/pipeline/agent-loop/tool-runner.ts) — внутренний `AbortController` в `withToolTimeout`.
- [src/pipeline/arbitration-room.ts](../../../src/pipeline/arbitration-room.ts) — timer вызывает `controllers[i].abort()`.
- [src/mcp/registry/types.ts](../../../src/mcp/registry/types.ts) (или рядом, где определён `ToolHandler`) — подпись получает optional `signal`.
- [src/mcp/registry/web.tools.ts](../../../src/mcp/registry/web.tools.ts), [consult.tools.ts](../../../src/mcp/registry/consult.tools.ts), [critic.tools.ts](../../../src/mcp/registry/critic.tools.ts) — принимают signal, передают в `PlaywrightClient` / `router.chat`.
- [src/lib/model-router.ts](../../../src/lib/model-router.ts) — `router.chat` композирует `AbortSignal.any([external, toolTimeoutSignal])`, прокидывает провайдерам.

Если суммарный diff перерастает 250 LoC — split:
- **20a — arbitration + tool-runner + handler signature (optional signal, без апдейтов регистров)**.
- **20b — sweep регистров (web/consult/critic) + router.chat композиция signal**.

## Изменение

### 1. `arbitration-room.ts` (малый)

В `callSpecialist`:

- `const controller = signal ? new AbortController() : <ignoring>` — уже есть массив `controllers` в `run()`.
- В `setTimeout(() => { controllers[i].abort(); reject(new Error("timeout")); }, timeout)` — объединённый callback.
- `router.chat(role, { ..., signal: controllers[i].signal }, "critical")` — уже есть параметр, просто перепривязать.

### 2. `tool-runner.ts`

`withToolTimeout(name, exec)` становится `withToolTimeout(name, exec, externalSignal?)`:

- Внутри создаёт `const controller = new AbortController()`.
- Если `externalSignal` передан — `AbortSignal.any([externalSignal, controller.signal])` как effective signal.
- `timer = setTimeout(() => controller.abort(), ms)` + обычный `reject`-sentinel.
- `exec` получает effective signal третьим аргументом.

### 3. Handler signature

```
type ToolHandler<T, R> = (
  args: T,
  ctx: ToolContext,
  signal?: AbortSignal
) => Promise<ToolResult<R>>;
```

`signal` **optional** — существующие handlers не обязаны его принимать. TS back-compat → только новые/long-running handlers апгрейдят подпись.

### 4. Update long-running handlers

Перечень файлов (именно там timeout-ы ≥ 15s) — **апдейтят подпись и передают signal**:

- `mcp/registry/web.tools.ts` → `ctx.executor.webTools.<op>(args, { signal })`. `PlaywrightClient` методы принимают `signal` в опциях; передать в `page.goto({ timeout, signal })` и подобное. Если Playwright API не принимает AbortSignal, делать собственный `signal.addEventListener("abort", () => page.close())`.
- `mcp/registry/consult.tools.ts` → передаёт `signal` в `ctx.router.chat(role, { ..., signal }, priority)`.
- `mcp/registry/critic.tools.ts` → аналогично.

Остальные handlers (memory_*, embed_*, task_*, done, create_tool/etc) — timeout 3–5s, кратковременные, abort некритично. Они не меняют подпись.

### 5. `router.chat` композиция

`ChatOptions.signal` уже поддерживается (см. `src/providers/types.ts`). Добавить композицию:

- `router.chat(role, opts, priority)` — если `opts.signal` + у backend'а свой cancel-signal (обычно нет), композировать. Иначе просто передавать `opts.signal` в provider.
- Провайдеры (copilot, nvidia, minimax, openrouter) **уже** должны проверять `signal.aborted` до старта и внутри stream callback (см. guardrail §2 — проверено в PR 01). Если не проверяют — отдельный fix в соответствующем провайдере.

## Тесты

`tests/tool-timeout-abort.test.ts`:

- Stub handler, который ждёт `await new Promise(r => setTimeout(r, 20_000))` но проверяет `signal.aborted` каждые 100ms через setTimeout-тик.
- Timeout `toolTimeoutMs` = 500ms.
- Assert: `executeAgentTool` возвращает `{error:{code:"timeout"}}` за ≤ 700ms.
- Assert: handler `signal.aborted === true` через 600ms (подтверждение что abort произошёл).

`tests/arbitration-abort.test.ts`:

- Mock `router.chat` — возвращает Promise который проверяет `opts.signal.aborted` в цикле.
- `ArbitrationRoom.run({ agents: ["coder","critic"], timeout: 300 })` — один agent мгновенный, второй бесконечный.
- После `run()` завершения — `opts.signal.aborted` для второго == true.

## Приёмка

- [x] `bunx tsc --noEmit` = 0.
- [x] Оба теста зелёные (`tests/tool-timeout-abort.test.ts` — 3 case, `tests/arbitration-abort.test.ts` — 2 case).
- [x] `grep -n 'Promise.race' src/pipeline/agent-loop/tool-runner.ts src/pipeline/arbitration-room.ts` — каждый случай имеет соседний `.abort()` / `controller.abort`.
- [ ] Integration test (live, opt-in): долгий web_navigate с 15s timeout на недоступный host → Playwright browser освобождается за ≤ 16s (не висит до HTTP default). *(опциональная live-проверка, не блокирует merge)*
- [x] CANCEL-1 вычеркнут в [docs/02-audit.md](../../02-audit.md).

## Deploy note

```bash
ssh root@109.120.187.244
cd /opt/subbrain
git pull
docker compose build && docker compose up -d
```

## Известные ограничения

- Если провайдер не реализует graceful cancel (старые copilot-streams с `keepAlive`) — abort может занять до heartbeat-интервала (≤ 5s). Приемлемо.
- Python-style «uncancellable» upstream (редкие LLM endpoints) — abort просто отключает нас от потока, токены на их стороне продолжают расходоваться. Вне нашего контроля.
