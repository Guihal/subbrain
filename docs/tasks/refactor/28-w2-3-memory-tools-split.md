# 28-W2-3 — split `mcp/tools/memory-tools.ts` (472 → split-folder)

**Status:** DONE. Master: [28-file-size-150-limit.md](28-file-size-150-limit.md) Wave 2.

## Цель

Разбить `packages/agent/src/mcp/tools/memory-tools.ts` (472 LOC) на split-folder. Public API сохранить — `MemoryTools` class с теми же методами (`read`, `write`, `delete`, `search`, `contextSummary`, `setMemoryService`).

## Файлы

**Удалить** (после переноса):
- `packages/agent/src/mcp/tools/memory-tools.ts`

**Создать**:
- `packages/agent/packages/agent/packages/agent/src/mcp/tools/memory/index.ts` — `MemoryTools` orchestrator class (≤150 LOC). Конструктор + setMemoryService + публичные методы как тонкие диспатчеры в submodules.
- `packages/agent/packages/agent/packages/agent/src/mcp/tools/memory/read.ts` — `readMemory(memory, id, layer?)` (read all 5 layers: context/archive/shared/agent/log + delegated to memory.repo where possible). Возвращает `ToolResult`.
- `packages/agent/packages/agent/packages/agent/src/mcp/tools/memory/write.ts` — `writeMemory(deps, params)` — самый большой кусок. Embed-first transactional shared writes (M-FINAL2 path + legacy `writeSharedAtomic` fallback). Внутри помощник `embedWithTimeout`. Категории: focus/shared/context/archive/agent. Использует `categoryToKind` + injected `memoryService` если есть.
- `packages/agent/packages/agent/packages/agent/src/mcp/tools/memory/delete.ts` — `deleteMemory(memory, id, layer?)` — диспатч по слоям.
- `packages/agent/packages/agent/packages/agent/src/mcp/tools/memory/search.ts` — `searchMemory(deps, params)` — FTS + vec поиск с rerank, работа с RAG.
- `packages/agent/packages/agent/packages/agent/src/mcp/tools/memory/context-summary.ts` — `contextSummary(memory, sessionId)`.
- `packages/agent/packages/agent/packages/agent/src/mcp/tools/memory/types.ts` — общие типы (если нужны), `EMBED_TIMEOUT_MS` константа, `embedWithTimeout` helper. Опционально — pure helpers могут жить в их модулях.

**Сохранить**:
- Все существующие импорты `MemoryTools` (через `~/mcp/tools/memory` или ./memory) — auto-resolve через `index.ts`.
- `packages/agent/packages/agent/packages/agent/src/mcp/tools/index.ts` или barrel — добавить re-export если был.

**Trigger**: `scripts/check-file-size.ts` `"packages/agent/src/mcp/tools/memory-tools.ts": 473` → удалить.

## Изменение

1. `index.ts` exports `class MemoryTools` с состоянием (memory, getRag, memoryService) + thin методы:
   ```ts
   read(id, layer?) { return readMemory(this.memory, id, layer); }
   write(p) { return writeMemory({memory, getRag, memoryService}, p); }
   ...
   ```
2. Submodules — pure functions, принимающие `deps` объекты явно. Никаких side-effect импортов.
3. `embedWithTimeout` — pure helper в `types.ts` или прямо в `write.ts` (если только write использует).
4. Inline комментарии MEM-2 (M-01), M-FINAL2, M-07.1 — переехать в `index.ts` JSDoc на класс + соответствующие модули (`write.ts` берёт основную часть).
5. Сохранить `setMemoryService` как mutator на класс (нужно для `ToolExecutor.setMemoryService`).
6. Проверить consumers: `grep -rn 'memory-tools\|MemoryTools' src/`. Любые `import { MemoryTools } from "...memory-tools"` → переключить на `...mcp/tools/memory` (через barrel).
7. `packages/agent/packages/agent/src/mcp/executor/index.ts` — вероятно главный consumer. Изменить только если изменился import path; не редактировать логику (это отдельный PR W3-6).

## Тесты

- `bun test tests/mcp-tools.test.ts` — green.
- `bun test tests/memory-service.test.ts` — green.
- `bun test tests/agent-loop*.test.ts` — green (использует MemoryTools транзитивно).

## Приёмка

Из repo root, exit 0:

1. `bun run scripts/check-file-size.ts` — все split-файлы ≤150 (index ≤150, остальные ≤150), transitional entry удалена.
2. `bun run scripts/check-deep-imports.ts` — без regression.
3. `bunx tsc --noEmit` — clean.
4. `bun test tests/repo-rules.test.ts` — 5/5.
5. `bun test` — без новых failed (baseline 838/0).
6. `grep -rn 'memory-tools' src/ tests/` — без deep-import'ов на split-internals (`./memory/write` etc. — только через `./memory`).

## Constraints

- Scope-lock: только файлы в §Файлы. Не редактировать `services/memory.service.ts`, `mcp/executor.ts`, `mcp/registry/*.tools.ts` (это W3-1/W3-6).
- Public API стабилен: `read/write/delete/search/contextSummary/setMemoryService` — те же сигнатуры.
- Сохранить всё inline-документирование MEM-2/M-FINAL2/M-07.1.
- Никаких новых пакетов / новых service'ов.
