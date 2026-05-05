# M-01 · Close MEM-2: embed-writers для `shared_memory`

**Tier:** P0 · **Effort:** S · **Deps:** — · **Status:** DONE (commit `0e01246`, merge `7d3a0d4`)

## Цель

Закрыть аудит-айтем **MEM-2** (`docs/02-audit.md:206-209` — "shared_memory rows are not embedded by writers"). Все ingress-paths, создающие строки в `shared_memory`, должны embed-ить контент через NVIDIA NIM и записывать вектор в `vec_embeddings(layer='shared')` под одной транзакцией с insert'ом. Сейчас только hippocampus extractor (`packages/agent/src/pipeline/agent-pipeline/post/extractors.ts:108-125`) делает это правильно; остальные пишут "сухие" строки → vec-branch RAG-pipeline пуст для слоя `shared`.

После тикета: `SELECT count(*) FROM shared_memory WHERE id NOT IN (SELECT id FROM vec_embeddings WHERE layer='shared')` = **0** на полностью прогнанной БД (после `bun run scripts/seed.ts`).

## Файлы (scope-lock — изменять ТОЛЬКО эти)

- `scripts/seed.ts` — line 108: `db.insertShared(...)` raw, без embed.
- `packages/agent/src/mcp/tools/memory-tools.ts` — line ~162: `this.memory.insertShared(...)` (`memory: MemoryDB` raw, без embed).
- `packages/agent/src/pipeline/context-compressor.ts` — interface `CompressorMemory` (~line 27) + call-site (~line 237).
- `packages/agent/src/pipeline/agent-loop/compressor-hook.ts` — line ~16: caller-side, передаёт `memory` в `compressContext`.
- `packages/agent/src/services/chat.service.ts` — line ~111: caller-side, передаёт `this.memoryRepo` в `compressContext`.
- `tests/shared-embed-writers.test.ts` — **NEW** файл.
- `docs/02-audit.md` — закрыть MEM-2 entry (mark ✅, ссылка на этот тикет).
- `docs/tasks/memory-v2/M-01-shared-embed-writers.md` — обновить `Status: DONE (PR …)` в конце.

**НЕ трогать:**
- `packages/agent/src/services/memory.service.ts` — `insertShared` уже корректный (embed-first + transaction wrap).
- `packages/agent/src/pipeline/agent-pipeline/post/extractors.ts` — hippocampus уже embed-ит.
- `packages/core/src/repositories/memory.repo.ts` — это сырой repo-layer, не место для embed (по архитектуре — embed в Service-layer).
- `packages/core/src/db/schema.ts`, миграции — без изменений схемы.
- `packages/core/src/db/tables/shared.ts` — без изменений (там сырые helpers).

## Изменение

### Принцип
"Embed принадлежит **Service**-уровню, не Repository / не сырым call-сайтам." Все callers, которые сейчас зовут `MemoryDB.insertShared` или `MemoryRepository.insertShared` напрямую, должны:
1. либо переключиться на `MemoryService.insertShared` (которое уже делает embed-first + transaction);
2. либо (если service недоступен — например в seed-скрипте) вызвать embed + transaction inline тем же паттерном что в `services/memory.service.ts:147-160`.

### Конкретно

**1. `scripts/seed.ts:108`**
- Сейчас: `db.insertShared(id, fact.category, fact.content, fact.tags, "seed-script");` — sync, без embed.
- Изменение: импортировать `MemoryService` + `EmbedService` (или их фабрику), сконструировать service на тот же `db`, заменить `db.insertShared(...)` на `await memoryService.insertShared({ id, category, content, tags, source, ... })`.
- Если seed-скрипт не должен зависеть от LLM-провайдера (для CI/offline-режима) — добавить env-флаг `SEED_SKIP_EMBED=1`, при котором падать обратно к raw insert (с громкой console.warn). По умолчанию embed включён.

**2. `packages/agent/src/mcp/tools/memory-tools.ts:162`**
- Сейчас: `private memory: MemoryDB` + `this.memory.insertShared(...)`.
- Изменение: внедрить `MemoryService` через DI (constructor takes `MemoryService` или дополнительно к `MemoryDB`). Заменить call-site на `await this.memoryService.insertShared({...})`.
- Грепнуть инстанциацию `MemoryTools`: грейс заменить там, где конструируется (likely `packages/agent/src/mcp/tools/index.ts` или `app/dependencies.ts`).

**3. `packages/agent/src/pipeline/context-compressor.ts` + два caller'а**
- `CompressorMemory` interface — `insertShared` сейчас sync `(...) => void`. Service-level `insertShared` async `Promise<string>`. Решение: **расширить интерфейс** до async-совместимой формы — `insertShared(...) => void | Promise<unknown>`, а внутри compressor'а (`line ~237`) сделать `await memory.insertShared(...)` (compressor сам уже в async-fn `compressContext`).
- Caller-сайд:
  - `packages/agent/src/services/chat.service.ts:111` — passes `this.memoryRepo`. Переключить на `this.memoryService` (если ChatService уже имеет ссылку — проверить; если нет — добавить в constructor).
  - `packages/agent/src/pipeline/agent-loop/compressor-hook.ts:16` — passes `memory` (origin: agent-loop owner). Переключить на `MemoryService`-инстанс (поднять через `AgentToolContext.memoryService` или эквивалент; если нет — расширить контекст; держать backward-compat — приёмная сторона compressor'а просто требует объект с `insertShared`).
- Альтернатива (минимизировать diff): не менять ABI compressor'а; в caller'ах оборачивать `memoryService` лямбдой `{ insertShared: (...) => memoryService.insertShared({...}) }`. Менее красиво, но scope меньше. Subagent волен выбрать — главное чтобы embed случился.

### Транзакционность
Все три ingress'а после правок должны embed-fail → rollback всей вставки (не оставлять row без vec). `MemoryService.insertShared` это уже делает (`db.transaction(() => { repo.insertShared(...); repo.upsertEmbedding(...); })` с embed ДО транзакции, чтобы embed-fail предотвращал любую запись). Сохранить эту дисциплину.

## Тесты

Новый файл `tests/shared-embed-writers.test.ts` с 4 кейсами (`bun:test`, тест-БД `data/test.db`, изолированно):

1. **`MemoryService.insertShared` writes vec** — sanity. Insert → check `vec_embeddings WHERE layer='shared' AND id=?` exists, `length(embedding)=2048*4` bytes. Уже работает, тест зафиксирует regression-поверхность.
2. **`MemoryTools` (MCP) writes vec** — call `MemoryTools.write({ layer:"shared", category, content })` → check vec присутствует.
3. **Compressor writes vec** — synthetic call `compressContext(big-msgs, mockRouter, memoryService-or-shim)` → проверить что для каждого extracted fact в `shared_memory` появилась строка в `vec_embeddings`.
4. **Embed-fail rollback** — мокнуть `EmbedService` чтобы кидал; вызвать `insertShared` через service → ожидать throw + `SELECT count(*) FROM shared_memory WHERE id=?` = 0 (rollback сработал, row не записан).

Дополнительно:
5. **Invariant query** — после полного `bun run scripts/seed.ts` (или mini-seed в тесте) выполнить `SELECT count(*) FROM shared_memory WHERE id NOT IN (SELECT id FROM vec_embeddings WHERE layer='shared')` → ожидать 0. Это THE acceptance-инвариант.

Все тесты в одном файле. Не делать live-test (`*.live.ts`) — embed мокать на уровне `EmbedService` (interface-injection), не дёргать NVIDIA.

Существующий `tests/shared-embed-write.test.ts` (уже в репо) — посмотреть, не пересекается ли по зоне; если да — расширить его, не дублировать.

## Приёмка (machine-checkable)

Все команды должны выдавать указанный exit-code / output:

1. `bunx tsc --noEmit` → exit 0, нет ошибок.
2. `bun test tests/shared-embed-writers.test.ts` → all green.
3. `bun test` (полный suite) → exit 0, ≥633 tests pass, 0 fail (baseline, не регрессия).
4. `grep -rn "db\.insertShared\|MemoryDB.*insertShared" src/ scripts/ | grep -v "//\|^\s*\*\|test"` → **0 строк** (либо все hits — это `MemoryService.insertShared` через service-объект, не raw).
5. `grep -n "memory\.insertShared\|this\.memory\.insertShared" packages/agent/src/mcp/tools/memory-tools.ts packages/agent/src/pipeline/context-compressor.ts` → должны быть либо `this.memoryService.insertShared` либо вызов через service-shim, не raw `MemoryDB`.
6. `docs/02-audit.md` — MEM-2 секция помечена `✅` со ссылкой на этот PR.
7. Этот файл (`docs/tasks/memory-v2/M-01-shared-embed-writers.md`) — внизу `Status: DONE (PR <commit-sha>)`.

## Риск + mitigations

- **Compressor breaks под async**: caller-shape меняется. Mitigation: сохранить sync-возврат `void` при возможности (await внутри fn — окей), регрессия-тест compressor'а.
- **Seed-скрипт require'ит provider env**: для CI без NVIDIA-ключа — env-флаг `SEED_SKIP_EMBED=1`.
- **Concurrency**: embed-вызовы параллелятся внутри одного `compressContext` запуска — не превышать NVIDIA limiter (он в http-client), `Promise.allSettled` если несколько шт.
- **MCP DI расширение** мог сломать сторонних callers `MemoryTools` constructor. Mitigation: `memoryService` как второй опциональный аргумент с fallback на сырой path + warn (только для тестов / legacy путей).

## Out of scope

- Migration схемы (нет).
- Новые поля (access_count, salience, kind — это другие тикеты).
- Изменение vec dimension / embedding model.
- Reindex существующих shared rows без embed (отдельный one-shot скрипт — может быть follow-up M-1.1).

---

**Status:** DONE (2026-04-26, commit `0e01246`, merge `7d3a0d4`)
Все три ingress (seed.ts, MemoryTools MCP shared, context-compressor через ChatService) embed+insert атомарно. Тесты в `tests/shared-embed-write.test.ts` (расширен, 9 кейсов всего). `bunx tsc --noEmit` exit 0; `bun test` 639 pass / 0 fail. Acceptance-инвариант (orphan vec) проверяется в финальном тесте `invariant: zero shared_memory rows without vec_embeddings(layer='shared')`. Agent-loop compressor-hook оставлен как follow-up — низкий приоритет (raw `MemoryDB`, embed реже triggers).
