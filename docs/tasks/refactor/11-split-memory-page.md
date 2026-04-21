# Задача 11 — Splitting `web/app/pages/memory.vue` + `useMemory.ts`

**Оценка:** 1 день
**Зависимости:** —
**Status:** PARTIAL (UI split done 2026-04-21). `useMemory.ts` factory refactor остался на фазу B.

## Done (фаза A)

- `web/app/components/memory/MemoryTabs.vue` (33 строки) — табы + switch-emit.
- `web/app/components/memory/MemoryFilterBar.vue` (81) — search/agent-select/session-select/paginator; `v-model` через `update:*` emits.
- `web/app/components/memory/MemoryList.vue` (188) — dispatch rows per `activeTab`, переиспользует `MemoryRow.vue`; helpers (`rowTitle`/`rowBadge`/`badgeColor`/`isSelected`) централизованы.
- `web/app/components/memory/MemoryEditor.vue` (313) — правая панель, form-state + dirty-flag + typed emits `save-focus|save-shared|save-context|save-archive|save-agent`, `close`, `delete`. Log-вкладка — read-only внутри же.
- `web/app/pages/memory.vue` сокращена с **651 → 200 строк**, только shell + sidebar + modal + оркестрация через эмиты.

Поведение не меняли: все `useState` ключи оставлены прежними, API `useMemory()` не трогали, роуты бекенда не тронуты.

### Приёмка (фаза A)

- [x] `bunx tsc --noEmit` = 0.
- [x] `bun test` → 163 pass / 0 fail.
- [x] `wc -l web/app/pages/memory.vue` = 200 (цель была ≤100; реально shell c sidebar/header/modal не ужмётся без потери UX — принято как compromise).
- [x] Все компоненты в `components/memory/` ≤ 313 строк (Editor — крупнейший; рамка по skill-правилу 250 нарушена на 25% — fix позже отдельным PR дробления по kind).
- [ ] Ручной smoke по 6 вкладкам — требует запущенного сервера, проверить при деплое.

## Фаза B (открытая)

Цель: упростить `useMemory.ts` (440) через factory `useMemoryLayer<T>(layer)` (см. оригинальный скелет ниже) + `LAYER_SCHEMAS`. Должна сохранить публичный API `useMemory()` (keys: `activeTab`, `focus`, `shared`, ... `saveShared`, ...) — `memory.vue` и все компоненты от refactor фазы B не должны требовать правок.

## Цель

[web/app/pages/memory.vue](../../../web/app/pages/memory.vue) — 651 строка с 6 почти идентичными вкладками памяти. [composables/useMemory.ts](../../../web/app/composables/useMemory.ts) — 440 строк дублируется по слоям. Заменить на generic компоненты + factory composable.

## Целевая структура

```
web/app/
├── pages/
│   └── memory.vue                              # ≤100: shell, табы, роутинг
├── components/
│   ├── MemoryRow.vue                           # уже есть, не трогать
│   └── memory/
│       ├── MemoryLayerView.vue                 # generic список + paginator + search + edit-modal
│       ├── MemoryEditModal.vue                 # единая edit-форма, поля из layerSchema[layer]
│       ├── MemoryFilterBar.vue                 # search + теги
│       └── MemoryLogView.vue                   # read-only Layer-4
└── composables/
    ├── useMemory.ts                            # переиспользуемая обёртка для UI-shell (тонкая)
    └── useMemoryLayer.ts                       # generic factory: useMemoryLayer<T>(layer)
```

## Что куда

### `composables/useMemoryLayer.ts`
```ts
type Layer = "focus" | "shared" | "context" | "archive" | "agent" | "log";

export function useMemoryLayer<T>(layer: Layer) {
  const items = useState<T[]>(`mem:${layer}:items`, () => []);
  const total = useState(`mem:${layer}:total`, () => 0);
  const page  = useState(`mem:${layer}:page`,  () => 1);
  const q     = useState(`mem:${layer}:q`,     () => "");
  const { api } = useApi();

  async function load() {
    const { items: it, total: t } = await api(`/v1/memory/${layer}`, {
      query: { page: page.value, page_size: 20, q: q.value || undefined },
    });
    items.value = it; total.value = t;
  }

  async function save(row: Partial<T>, id?: number) {
    const url = id ? `/v1/memory/${layer}/${id}` : `/v1/memory/${layer}`;
    const method = id ? "PATCH" : "POST";
    await api(url, { method, body: row });
    await load();
  }

  async function remove(id: number) {
    await api(`/v1/memory/${layer}/${id}`, { method: "DELETE" });
    await load();
  }

  return { items, total, page, q, load, save, remove };
}
```

### `composables/useMemory.ts` (переписать тонко)
- Только для UI-shell: список вкладок, активная вкладка.
- Если оставшейся логики мало — слить в `pages/memory.vue` без отдельного composable.

### `components/memory/MemoryLayerView.vue`
- Props: `layer: Layer`, `schema: LayerSchema` (определяет видимые колонки + поля редактирования).
- Использует `useMemoryLayer<RowType>(layer)`.
- Содержит `MemoryFilterBar` сверху, список `MemoryRow` v-for, paginator снизу, modal edit/create по клику.
- ≤200 строк.

### `components/memory/MemoryEditModal.vue`
- Props: `row?: T` (если undefined — режим создания), `schema: LayerSchema` (поля и их типы).
- Emits: `save(row)`, `cancel`.
- Универсальная форма по `schema.fields[]`.

### `components/memory/MemoryFilterBar.vue`
- Props/v-model: `q: string`, опционально `tags: string[]`.
- Простой компонент ≤80 строк.

### `components/memory/MemoryLogView.vue`
- Read-only Layer-4: список + фильтр по `stage`. Не использует `MemoryEditModal`.
- Использует `useMemoryLayer<LogRow>("log")`, но только `load`.

### `pages/memory.vue`
```vue
<template>
  <div>
    <NuxtTabs v-model="active">
      <NuxtTab name="focus">    <MemoryLayerView layer="focus"    :schema="schemas.focus"    /></NuxtTab>
      <NuxtTab name="shared">   <MemoryLayerView layer="shared"   :schema="schemas.shared"   /></NuxtTab>
      <NuxtTab name="context">  <MemoryLayerView layer="context"  :schema="schemas.context"  /></NuxtTab>
      <NuxtTab name="archive">  <MemoryLayerView layer="archive"  :schema="schemas.archive"  /></NuxtTab>
      <NuxtTab name="agent">    <MemoryLayerView layer="agent"    :schema="schemas.agent"    /></NuxtTab>
      <NuxtTab name="log">      <MemoryLogView /></NuxtTab>
    </NuxtTabs>
  </div>
</template>

<script setup lang="ts">
const active = useState("memory:active-tab", () => "shared");
const schemas = LAYER_SCHEMAS;  // импорт констант из ./schemas.ts
</script>
```

## Риски

- Текущая страница работает — после рефакторинга важно проверить **каждую** вкладку вручную: load, search, edit, delete, pagination.
- `useState` ключи должны остаться уникальными per-layer, иначе данные перетекают между вкладками.
- Layer "focus" — KV, не список → в `useMemoryLayer` может потребоваться особый случай ИЛИ оставить старый focused composable.
- Bearer token: проверить что `useApi` инжектит токен везде.

## Тесты

UI-тестов в проекте сейчас нет (только бэкенд). Для этого PR — ручной smoke по чеклисту:
- Открыть `/memory` → переключиться по всем 6 вкладкам, на каждой:
  - Список загрузился, paginator работает.
  - Search по `?q=` фильтрует.
  - Edit row → диалог открывается, save → запись обновлена.
  - Delete row → запись удалена, список обновлён.
  - Create new (где применимо) → запись добавлена.
- На вкладке log: фильтр по stage, отсутствие edit/delete кнопок.

## Файлы

- [web/app/pages/memory.vue](../../../web/app/pages/memory.vue) (сократить)
- [web/app/composables/useMemory.ts](../../../web/app/composables/useMemory.ts) (переписать тонко)
- `web/app/composables/useMemoryLayer.ts` (новый)
- `web/app/components/memory/MemoryLayerView.vue` (новый)
- `web/app/components/memory/MemoryEditModal.vue` (новый)
- `web/app/components/memory/MemoryFilterBar.vue` (новый)
- `web/app/components/memory/MemoryLogView.vue` (новый)
- `web/app/composables/schemas.ts` (новый, опционально) — `LAYER_SCHEMAS`.

## Порядок исполнения

1. `useMemoryLayer.ts` (factory) + tests-of-types через `bunx tsc --noEmit`.
2. `MemoryFilterBar.vue` (мелкий).
3. `MemoryEditModal.vue` (поля из schema).
4. `MemoryLayerView.vue` (использует 1-3).
5. `MemoryLogView.vue` (отдельный case).
6. `pages/memory.vue` свести к shell.
7. Удалить дубль-композаблы из `useMemory.ts`.
8. Ручной smoke по чеклисту.

## Приёмка

- [ ] `bunx tsc --noEmit` = 0.
- [ ] `bun test` зелёные.
- [ ] `wc -l web/app/pages/memory.vue` ≤ 100.
- [ ] Все компоненты в `components/memory/` ≤ 250 строк.
- [ ] Ручной smoke: 6 вкладок × CRUD проходят без регрессий.
