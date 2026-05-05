# Задача 13 — AppError + `logger.child` + `PaginatedResponse`

**Оценка:** 0.5 дня
**Зависимости:** после PR 10 (`db/tables/*` стабилизированы — paginate работает поверх единообразных getters)
**Status:** DONE

## Цель

Три параллельных упрощения из «Часть III» мастер-плана:
1. Единый `AppError` + central `onError` в Elysia.
2. `logger.child("stage")` — отказ от повторения stage-имени в каждом вызове.
3. `lib/api-envelope.ts` — `PaginatedResponse<T>` + `paginate(query, opts)` для единого формата `{items, total}`.

## Пункты

### 1. AppError + central `onError`

**Файлы:** `packages/core/packages/core/src/lib/errors.ts`, `packages/server/packages/server/packages/server/src/app/bootstrap.ts` (после PR 07).

```ts
// packages/core/src/lib/errors.ts
export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 500,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export class UpstreamExhaustedError extends AppError {
  constructor(details?: Record<string, unknown>) {
    super("upstream_exhausted", "All upstream attempts failed", 502, details);
  }
}

export class ToolError extends AppError {
  constructor(toolName: string, code: string, message: string) {
    super(code, message, 200, { tool: toolName });  // status 200: tool errors не HTTP-ошибки
  }
}
```

В `bootstrap.ts`:
```ts
app.onError(({ error, set }) => {
  if (error instanceof AppError) {
    set.status = error.status;
    return { error: { code: error.code, message: error.message, ...error.details } };
  }
  if (error.code === "VALIDATION") {  // TypeBox
    set.status = 400;
    return { error: { code: "validation_error", message: error.message } };
  }
  set.status = 500;
  logger.error("http", "unhandled", { err: error.message, stack: error.stack });
  return { error: { code: "internal_error", message: "internal" } };
});
```

Удалить локальные `.onError(...)` в `routes/*.ts` (10 мест).

### 2. `logger.child("stage")`

**Файл:** [packages/core/src/lib/logger.ts](../../../packages/core/src/lib/logger.ts)

```ts
export interface ScopedLogger {
  info: (msg: string, meta?: object) => void;
  warn: (msg: string, meta?: object) => void;
  error: (msg: string, meta?: object) => void;
  debug: (msg: string, meta?: object) => void;
  child: (subStage: string) => ScopedLogger;  // вкладывается: copilot → copilot.stream
}

export function createLogger(stage: string, baseMeta: object = {}): ScopedLogger {
  return {
    info: (m, meta) => writeLog("info", stage, m, { ...baseMeta, ...meta }),
    warn: (m, meta) => writeLog("warn", stage, m, { ...baseMeta, ...meta }),
    error: (m, meta) => writeLog("error", stage, m, { ...baseMeta, ...meta }),
    debug: (m, meta) => writeLog("debug", stage, m, { ...baseMeta, ...meta }),
    child: (sub) => createLogger(`${stage}.${sub}`, baseMeta),
  };
}

export const logger = createLogger("root");
```

Миграция call-sites:
- В каждом файле: `const log = logger.child("copilot")` (или `"agent-loop"`, и т.п.).
- Дальше: `log.info("started", {...})` вместо `logger.info("copilot", "started", {...})`.

Прежний API `logger.info("stage", "msg", meta)` оставить рабочим — ⚠️ существующая контракт-проверка из CLAUDE.md: пропуск аргумента → garbage в Layer 4. Сохранить эту защиту: первый аргумент обязателен и валидируется.

### 3. `lib/api-envelope.ts`

**Файл:** `packages/core/packages/core/src/lib/api-envelope.ts` (новый), `packages/server/packages/server/packages/server/src/routes/memory.ts`, потенциально `routes/chats.ts`, `routes/logs.ts`.

```ts
export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
}

export interface PaginateOpts {
  page?: number;       // 1-based
  page_size?: number;  // default 20, max 200
  q?: string;
}

export async function paginate<T>(
  loader: (limit: number, offset: number, q?: string) => { items: T[]; total: number },
  opts: PaginateOpts,
): Promise<PaginatedResponse<T>> {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, opts.page_size ?? 20));
  const offset = (page - 1) * pageSize;
  const { items, total } = await loader(pageSize, offset, opts.q);
  return { items, total, page, page_size: pageSize };
}
```

В `routes/memory.ts` каждый из 5 layer-эндпоинтов:
```ts
.get("/v1/memory/shared", ({ query }) =>
  paginate(
    (limit, offset, q) => q
      ? db.searchSharedFts(q, limit, offset).then(rehydrateShared)
      : db.listShared(limit, offset),
    query,
  ),
)
```

## Тесты

- `tests/api-envelope.test.ts` — `paginate()` с разными `page_size`, clamp до max 200, q passthrough.
- `tests/logger-child.test.ts` — `logger.child("a").child("b").info("msg")` записывает stage `root.a.b`.
- `tests/error-handler.test.ts` — `throw new AppError("x", "msg", 418)` через тестовый Elysia → response 418 с `{error: {code: "x", message: "msg"}}`.

## Файлы

- `packages/core/packages/core/src/lib/errors.ts` (новый/расширить)
- `packages/core/packages/core/src/lib/logger.ts` (расширить)
- `packages/core/packages/core/src/lib/api-envelope.ts` (новый)
- `packages/server/packages/server/packages/server/src/app/bootstrap.ts` (central onError)
- `packages/server/src/routes/*.ts` — удалить локальные `.onError`, переключить на envelope.
- Все файлы где сейчас `logger.info("stage", ...)` повторяется ≥3 раз → завести `const log = logger.child("stage")`.
- Тесты выше.

## Порядок исполнения

1. `errors.ts` + `bootstrap.ts` central onError. Прогон тестов.
2. `logger.child` + миграция top-используемых файлов (`copilot.ts`, `nvidia.ts`, `agent-loop/*`, `pipeline/*`).
3. `api-envelope.ts` + миграция `routes/memory.ts`.
4. По возможности — `routes/chats.ts` и `routes/logs.ts`.

## Приёмка

- [ ] `bunx tsc --noEmit` = 0.
- [ ] `bun test` зелёные.
- [ ] Grep `\.onError\(` в `packages/server/src/routes/` → 0 совпадений (всё через central).
- [ ] Grep `logger\.(info|warn|error|debug)\("[^"]+",\s*"` в файлах с ≥3 совпадениями → переведено на `log.<level>(...)`.
- [ ] Memory admin endpoints возвращают `PaginatedResponse<T>`-совместимый объект — frontend не сломан.
