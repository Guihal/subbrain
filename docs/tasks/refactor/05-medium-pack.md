# Задача 05 — MEDIUM pack (MED-1..MED-14)

**Оценка:** 1 день
**Зависимости:** —
**Status:** DONE

## Цель

Один PR «hardening quality» — собрать 14 мелких MED-правок. Каждый пункт — точечная замена с конкретной мотивацией. Не превращать в рефакторинг — только замены, описанные ниже.

## Пункты

### MED-1 — generic `updateRow(table, allowlist, id, patch)`

**Файл:** [packages/core/src/db/index.ts](../../../packages/core/src/db/index.ts)

- Сейчас N руками написанных `update*` методов. Каждый принимает `Partial<X>` и собирает `SET col = ?` руками.
- Вынести `updateRow(table: string, allowlist: Set<string>, id: number, patch: Record<string, unknown>): void`.
- Аллоулист колонок — `Set<string>` рядом с описанием таблицы (под комментарием `// columns updatable from REST/UI`).
- Вызовы переписать: `updateShared({id, patch})` → `updateRow("shared_memory", SHARED_UPDATABLE, id, patch)`.

### MED-2 — `RERANK_MODEL` константа

**Файл:** [packages/core/src/lib/model-map.ts](../../../packages/core/src/lib/model-map.ts)

- Добавить `export const RERANK_MODEL = "nvidia/llama-3_2-nv-rerankqa-1b-v2"` (или то, что сейчас захардкожено) рядом с `EMBED_MODEL`.
- Заменить захардкоженную строку в [packages/agent/src/rag/pipeline/index.ts](../../../packages/agent/src/rag/pipeline/index.ts) на импорт.

### MED-3 — `scripts/seed.ts` требует `--confirm` или path≠prod

**Файл:** [scripts/seed.ts](../../../scripts/seed.ts)

- В начале скрипта:
  ```ts
  const dbPath = process.env.MEMORY_DB_PATH ?? "data/subbrain.db";
  const isProd = dbPath.endsWith("subbrain.db") && !dbPath.includes("test");
  if (isProd && !process.argv.includes("--confirm")) {
    console.error("seed: prod DB detected, pass --confirm to override");
    process.exit(1);
  }
  ```

### MED-4 — `JSON.stringify` всех meta-значений в логе

**Файл:** [packages/core/src/lib/logger.ts](../../../packages/core/src/lib/logger.ts), строка ~107

- Сейчас при записи в SQLite `meta` иногда оказывается объектом, SQLite принимает только строку — где-то падает silent.
- Перед записью: `db.prepare(...).run(stage, message, JSON.stringify(meta ?? null))`.

### MED-5 — Worker availability check в sandbox

**Файл:** [packages/agent/src/pipeline/agent-loop/code-tools/sandbox.ts](../../../packages/agent/src/pipeline/agent-loop/code-tools/sandbox.ts), строка ~43

```ts
if (typeof Worker === "undefined") {
  throw new Error("sandbox_unavailable: Worker API not present");
}
```

- Не fallback'иться на `new Function()` (это снос всей изоляции).

### MED-6 — `Message.reasoning_content?: string`

**Файл:** [packages/providers/src/types.ts](../../../packages/providers/src/types.ts)

- Добавить поле `reasoning_content?: string` в `Message`.
- Грепнуть `(m as any).reasoning_content` по pipeline → заменить на `m.reasoning_content`.

### MED-7 — лишний `Promise.all` в pre-processing

**Файл:** [packages/agent/src/pipeline/agent-pipeline/pre-processing.ts](../../../packages/agent/src/pipeline/agent-pipeline/pre-processing.ts), строки 151-154

- Вокруг синхронного кода обёрнут `Promise.all` без причины — убрать.

### MED-8 — дедуп перед `rrfMerge`

**Файл:** [packages/agent/src/rag/pipeline/index.ts](../../../packages/agent/src/rag/pipeline/index.ts), строка ~69

- Перед `rrfMerge` — `Map<id, Result>` для дедупа (FTS и vec могут вернуть одну и ту же запись).

### MED-9 — пересчёт embedding после merge в night-cycle

**Файл:** [packages/agent/src/pipeline/night-cycle/steps.ts](../../../packages/agent/src/pipeline/night-cycle/steps.ts), функция `updateArchive`

- После merge содержимого записи — заново считать embedding и `rag.indexEntry(id, newVector)`.
- Иначе обновлённый текст ищется по старому вектору.

### MED-10 — миграция v3 в `db.transaction()`

**Файл:** [packages/core/src/db/schema.ts](../../../packages/core/src/db/schema.ts)

- Сейчас миграция v3 — последовательность DROP + RENAME без транзакции; вылет посередине = битая БД.
- Обернуть тело миграции v3 в `db.transaction(() => { ... })()`.

### MED-11 — маск `api_key`/`authorization`/`token` в `routes/logs.ts`

**Файл:** [packages/server/src/routes/logs.ts](../../../packages/server/src/routes/logs.ts)

- По умолчанию заменять значения полей с именами `api_key | api-key | authorization | token | bearer` на `***` (regex по сериализованному `meta`).
- `?raw=1` снимает маскирование (для отладки).

### MED-12 — `msg.slice(0, 500)` в SSE error

**Файл:** [packages/core/src/lib/model-router.ts](../../../packages/core/src/lib/model-router.ts), строка ~269

- Сейчас в SSE-ошибку утекает полное тело ответа провайдера (может быть многомегабайтный HTML).
- `event: error\ndata: ${JSON.stringify({error: msg.slice(0, 500)})}\n\n`.

### MED-13 — `logger.error` вместо `console.error` в `stream-utils`

**Файл:** [packages/providers/src/stream-utils.ts](../../../packages/providers/src/stream-utils.ts), строка ~37

- Заменить `console.error(...)` на `logger.error("stream-utils", message, {extra})`.

### MED-14 — обрезание тела ошибки в `routes/chat.ts`

**Файл:** [packages/server/src/routes/chat.ts](../../../packages/server/src/routes/chat.ts), строка ~131

- `err.body.slice(0, 200)` + `body.replace(/api[_-]?key/i, "***")` (regex-redact).

## Файлы (сводка)

- `packages/core/src/db/index.ts`, `packages/core/src/db/schema.ts`
- `packages/core/src/lib/model-map.ts`, `packages/core/src/lib/logger.ts`, `packages/core/src/lib/model-router.ts`
- `packages/providers/src/types.ts`, `packages/providers/src/stream-utils.ts`
- `packages/agent/src/pipeline/agent-pipeline/pre-processing.ts`
- `packages/agent/src/pipeline/agent-loop/code-tools/sandbox.ts`
- `packages/agent/src/pipeline/night-cycle/steps.ts`
- `packages/agent/src/rag/pipeline/index.ts`
- `packages/server/src/routes/logs.ts`, `packages/server/src/routes/chat.ts`
- `scripts/seed.ts`

## Тесты

Минимальные для каждого:
- MED-3: `tests/seed-script.test.ts` — запуск без `--confirm` на `data/subbrain.db` → exit 1.
- MED-4: `tests/logger.test.ts` — meta=`{x:1}` записывается как строка, не падает.
- MED-5: `tests/sandbox.test.ts` — мок `globalThis.Worker = undefined` → throw `sandbox_unavailable`.
- MED-10: `tests/db-migrations.test.ts` — мок ошибки в середине v3 → схема осталась v2 (rollback сработал).
- MED-11: `tests/routes-logs.test.ts` — meta содержит `api_key: "secret"` → в ответе `***`; `?raw=1` → `secret`.

Остальные MED-ы покрываются существующими тестами + ручным smoke в integration.live.ts.

## Порядок исполнения

Сверху вниз по списку. Коммиты атомарно по каждому MED — легче откат отдельного.

## Приёмка

- [ ] `bunx tsc --noEmit` = 0.
- [ ] `bun test` все зелёные.
- [ ] `bun run tests/integration.live.ts` end-to-end проходит.
- [ ] Все 14 MED вычеркнуты в [docs/02-audit.md](../../02-audit.md) с ссылкой на единый PR.
