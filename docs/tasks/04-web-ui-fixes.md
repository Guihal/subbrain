# Задача 04 — Починка Web UI: thinking и навигация

## Цель

1. Вернуть видимость «рассуждений» модели в режиме thinking: сейчас стримится, но в UI не показывается.
2. Починить навигацию — из `/memory` сейчас невозможно выйти иначе как через URL-бар. Добавить постоянные ссылки в левую панель на всех страницах.

## Баг 1 — thinking не виден

### Диагностика

Подозрительные места (проверять в таком порядке):

1. **Фронт — парсер SSE в `web/app/composables/useChat.ts`.**
   - Найти обработку `choices[].delta`. Почти наверняка обрабатывается только `delta.content`, а `delta.reasoning_content` или `delta.thinking` молча игнорируются.
2. **Провайдер — `src/providers/copilot.ts`.**
   - Grep по `reasoning`, `thinking`. Если поле выкидывается при сборке стрима — чинить тут.
3. **SSE-прокси — `src/providers/stream-utils.ts:createProxyStream` / `src/lib/sse.ts:sseResponse`.**
   - Не должен трогать payload (просто пересылает chunks), но проверить — вдруг парсит и отдаёт только content.
4. **Опциональная обёртка — `wrapStreamForChat` в `src/routes/chat.ts`.**
   - Эта обёртка собирает messages для персистенса в `chats`. Там может быть пропущено поле `reasoning_content` при конкатенации — тогда не пишется в БД и не рендерится при reload'е сессии.

### Фикс

1. В парсере SSE фронта — аккумулировать `delta.reasoning_content` (и fallback `delta.thinking`) в отдельное поле сообщения `msg.thinking`.
2. В `wrapStreamForChat` — добавить накопление `reasoning_content` и сохранение в `messages.thinking` (возможно нужна колонка в БД; если её нет — хранить в `metadata` JSON, чтобы не делать миграцию).
3. В компоненте сообщения (часть `ChatSidebar.vue` или отдельный `ChatMessage.vue`) — рендерить:
   ```vue
   <details v-if="msg.thinking" class="thinking">
     <summary>Рассуждения</summary>
     <pre>{{ msg.thinking }}</pre>
   </details>
   ```
   Свёрнуто по умолчанию. Стилизовать менее заметно, чем сам ответ.

### Проверка

- Ручная: отправить сообщение на thinking-модель (`teamlead` / `generalist` на Claude 4+ или `coder` на моделях с thinking), увидеть `<details>` до прихода основного `content`.
- E2E: `tests/e2e/thinking.spec.ts` (Playwright) — мок-провайдер отдаёт SSE с `reasoning_content`, проверка DOM содержит `<details>` c текстом ≥ 10 символов.

## Баг 2 — нет выхода из `/memory`

### Причина

`ChatSidebar.vue` рендерится только в `web/app/pages/index.vue` (главной). На странице `/memory` сайдбара нет вообще — отсюда и «выйти только через URL».

### Фикс (предпочтительный — один layout для всех страниц)

1. Создать `web/app/layouts/default.vue`:
   ```vue
   <template>
     <div class="app-shell">
       <ChatSidebar class="sidebar" />
       <main class="content"><slot /></main>
     </div>
   </template>
   ```
2. В `ChatSidebar.vue`:
   - Добавить пункт `💬 Чат` вверху (`NuxtLink to="/"`).
   - Пункт `🧠 Память` уже есть — оставить.
   - При появлении страницы `/freelance` (задача 03) — там тоже добавить пункт.
   - Активный пункт подсветить через класс `router-link-active` (Nuxt ставит автоматически) — отдельный CSS.
3. Страницы `index.vue`, `memory.vue`, `freelance.vue` — удалить ручной импорт `ChatSidebar` (layout сам рендерит).
4. Проверить: `useChat`, `useMemory`, `useFreelance` — composables с `useState` (SSR-safe), дублирования стейта между страницами не будет.

### Альтернатива (быстрый патч, не решает системно)

В header `web/app/pages/memory.vue` — `<NuxtLink to="/">← Чат</NuxtLink>`. Минута работы, но каждая будущая страница требует повторения — не берём.

### Проверка

- Ручная: открыть `/`, `/memory`, `/freelance` — сайдбар везде, активный пункт подсвечен.
- E2E: `tests/e2e/navigation.spec.ts` — переход `/` → `/memory` → `/` через сайдбар (не через URL).

## Файлы

- `web/app/composables/useChat.ts` (thinking parsing)
- `web/app/components/ChatSidebar.vue` (пункт «Чат», active state)
- `web/app/components/ChatMessage.vue` или inline (рендер `<details>`)
- `web/app/layouts/default.vue` (новый)
- `web/app/pages/index.vue`, `memory.vue` (убрать ручной sidebar)
- `src/providers/copilot.ts` — только если thinking теряется в провайдере
- `src/routes/chat.ts` (`wrapStreamForChat` — накопление `reasoning_content` для персистенса)
- `tests/e2e/thinking.spec.ts` (новый)
- `tests/e2e/navigation.spec.ts` (новый)

## Порядок исполнения

1. **Баг 2 сначала** — проще и снимает ежедневное раздражение.
2. **Баг 1 вторым** — диагностика через DevTools (глянуть network-таб на SSE), потом по стэку от фронта к провайдеру.
