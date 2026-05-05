# Задача 07 — Splitting `packages/server/src/index.ts` → `packages/server/src/app/*`

**Оценка:** 0.5 дня
**Зависимости:** —
**Status:** DONE

## Цель

[packages/server/src/index.ts](../../../packages/server/src/index.ts) разросся до ~440 строк: bootstrap Elysia, оба scheduler'а, autonomous-run SSE-loop, graceful shutdown — всё в одном файле. Разнести по `packages/server/src/app/`, `packages/server/src/index.ts` оставить ~50 строк.

## Целевая структура

```
packages/server/src/app/
├── bootstrap.ts        # createApp(): Elysia + mount routes + middleware + listen
├── schedulers.ts       # night-cycle + autonomous, идемпотентные guards
├── autonomous-run.ts   # SSE heartbeat loop (сейчас inline ~60 строк в index.ts)
└── shutdown.ts         # graceful shutdown: db.close, playwright cleanup, лог leak

packages/server/src/index.ts            # ~50 строк: import {createApp, registerSchedulers, registerShutdown}; start
```

## Что куда

### `packages/server/src/app/bootstrap.ts`
- `createApp(deps): Elysia` — создание Elysia, `.use(authMiddleware)`, `.group("/v1", ...)`, mount всех роутов из `packages/server/src/routes/*`.
- `idleTimeout: 255` в `.listen()` (см. CLAUDE.md — нужен для SSE).
- Возвращает `{ app, deps }`.
- Зависимости (`MemoryDB`, `ModelRouter`, `RAGPipeline`, `PlaywrightClient`) — параметром, не импортами singleton'ов. Упрощает тесты.

### `packages/server/src/app/schedulers.ts`
- `installNightCycleScheduler(deps, opts)` — `setInterval` с проверкой `NIGHT_CYCLE_SCHEDULER !== "false"`, час из `NIGHT_CYCLE_HOUR_UTC`.
- `installAutonomousScheduler(deps, opts)` — отдельный, аналогично, AUTONOMOUS_MAX_STEPS clamping.
- Оба используют общий guard `nightCycleRunning` / `autonomousRunning` (вынести в модуль-локальные `let`-флаги или переиспользовать существующие).
- Catch-up при старте: проверка `night_cycle_last_processed_id` vs current log count, если backlog ≥ `NIGHT_CYCLE_BACKLOG_TRIGGER` → 2-минутный таймер.

### `packages/server/src/app/autonomous-run.ts`
- `runAutonomousSSE(req, deps): Response` — извлечь inline-логику из `packages/server/src/index.ts` (`: ping\n\n` каждые 5 сек, обработка abort).
- Используется и из роута, и из scheduler'а — общий entrypoint.

### `packages/server/src/app/shutdown.ts`
- `registerShutdown(server, deps)` — `process.on("SIGINT" | "SIGTERM" | "beforeExit", ...)`.
- `db.close()`, `playwrightClient.close()`, лог числа открытых контекстов (см. PR 06 шаг C).

### `packages/server/src/index.ts`
```ts
import { initDeps } from "./app/deps.ts";  // если выделим
import { createApp } from "./app/bootstrap.ts";
import { installNightCycleScheduler, installAutonomousScheduler } from "./app/schedulers.ts";
import { registerShutdown } from "./app/shutdown.ts";

const deps = await initDeps();
const { app } = createApp(deps);
const server = app.listen({ port: 4000, idleTimeout: 255 });
installNightCycleScheduler(deps, {});
installAutonomousScheduler(deps, {});
registerShutdown(server, deps);
console.log("subbrain :4000");
```

## Риски и заметки

- Singleton'ы (`db`, `router`, `rag`) сейчас импортируются по всему коду. Не удалять — миграция «передавать deps параметром» — отдельная задача (Часть IV `AgentContext`). В этом PR — только перенос файлов.
- Импорты из других модулей (`routes/*`, `pipeline/*`) в `packages/server/src/index.ts` сейчас могут содержать боковые эффекты — после переноса проверить порядок инициализации (`db.migrate()` обязан случиться **до** mount роутов).
- `tests/integration.live.ts` запускает сервер вручную — должен продолжить работать без изменений.

## Тесты

- `tests/app-bootstrap.test.ts` (новый, smoke) — `createApp({...mocks})` возвращает Elysia с N маршрутами; `app.handle(new Request(...))` отвечает 200 на `/health`.
- Существующие `tests/*` — все продолжают зеленеть без изменений.

## Файлы

- [packages/server/src/index.ts](../../../packages/server/src/index.ts) (сильно сократить)
- `packages/server/src/app/bootstrap.ts` (новый)
- `packages/server/src/app/schedulers.ts` (новый)
- `packages/server/src/app/autonomous-run.ts` (новый)
- `packages/server/src/app/shutdown.ts` (новый)
- `tests/app-bootstrap.test.ts` (новый)
- [docs/completed/01-server-skeleton.md](../../completed/01-server-skeleton.md) — обновить структуру.
- [CLAUDE.md](../../../CLAUDE.md) — обновить пути в секциях про request flow.

## Приёмка

- [ ] `bunx tsc --noEmit` = 0.
- [ ] `bun test` все зелёные.
- [ ] `bun run packages/server/src/index.ts` стартует, `/health` 200.
- [ ] `bun run tests/integration.live.ts` end-to-end проходит.
- [ ] `wc -l packages/server/src/index.ts` ≤ 60.
