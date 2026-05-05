# Задача 22b — Memory approval UI

**Оценка:** 0.5 дня
**Зависимости:** 22a
**Status:** DONE (PR 22b)

## Цель

Пользовательский интерфейс для approve/reject pending rows, созданных post-hippocampus'ом в PR 22a.

## Файлы

- [packages/server/packages/server/src/routes/memory.ts](../../../packages/server/packages/server/src/routes/memory.ts) — `/v1/memory/pending`, `PATCH :id/status`.
- [web/app/pages/memory.vue](../../../web/app/pages/memory.vue) — таб «Pending».
- [web/app/composables/useMemory.ts](../../../web/app/composables/useMemory.ts) — `approveMemory`, `rejectMemory`.
- [web/app/components/MemoryRow.vue](../../../web/app/components/MemoryRow.vue) — при `status === "pending"` показывать кнопки.

## Изменение

### 1. HTTP

- `GET /v1/memory/pending?layer=shared|context&page=1` — список `status='pending'` per layer. Envelope `{ items, total }` через `paginate`.
- `PATCH /v1/memory/:layer/:id/status` — body `{ status: "active" | "rejected" }`. 404 если row отсутствует. 422 если status невалиден.
- Оба под `authMiddleware`. Мутации через `updateRow(table, ALLOW, id, patch)`; `status` добавить в ALLOW-list для shared/memory.

### 2. UI

- В `memory.vue` рядом с текущими 6 табами — новая «Pending» (с счётчиком pending rows).
- На каждой row рендерить кнопки «✓ Approve» и «✗ Reject» если `status === "pending"`.
- После approve/reject row исчезает из pending-таба + обновляется счётчик.

### 3. Composable

```
function approveMemory(layer: "shared" | "context", id: string): Promise<void>;
function rejectMemory(layer: "shared" | "context", id: string): Promise<void>;
```

Оба делают `PATCH /v1/memory/:layer/:id/status`.

## Тесты

`tests/memory-pending-route.test.ts`:

- `GET /v1/memory/pending?layer=shared` — возвращает только `status='pending'`.
- `PATCH /v1/memory/shared/:id/status` body `{status: "active"}` → 200, row теперь active.
- `PATCH ...` body `{status: "garbage"}` → 422.
- Несуществующий id → 404 shape `{ error: { message } }`.

UI component test (Vitest/Vue Test Utils):

- Render `MemoryRow` с `status='pending'` → кнопки видны.
- Click «Approve» → `approveMemory` вызвана.
- `status='active'` → кнопки скрыты.

## Приёмка

- [ ] `bunx tsc --noEmit` = 0.
- [ ] Routes + UI тесты зелёные.
- [ ] Руками: при `memory_write confidence: 0.5` через агент → новая row появляется в UI Pending-табе. Approve → переезжает в Active-таб (через мгновение).
- [ ] MEM-5 вычеркнут (совместно с 22a) в [docs/02-audit.md](../../02-audit.md).

## Deploy note

```bash
ssh root@109.120.187.244
cd /opt/subbrain
git pull
docker compose build && docker compose up -d
# Frontend rebuild попадёт через docker build если web/ в image
```
