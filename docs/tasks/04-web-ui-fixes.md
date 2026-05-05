# Задача 04 — Web UI: редизайн, thinking, автономный режим, навигация

Status: PARTIAL — Баги 1/2/3/4 — DONE. Редизайн (пункт 4) — отдельным PR через frontend-design.

**Баг 3 закрыт (2026-04-21):** 05 A1 smoke прошёл, бэкенд `packages/agent/packages/agent/packages/agent/packages/agent/src/pipeline/agent-loop/stream.ts` уже эмитит `thinking`/`tool_call`/`tool_result`/`response`/`step`/`done`/`error`, фронт `web/app/composables/useChatStream.ts::readAgentSSE` все эти события консьюмит и рендерит в reasoning/content. Никаких кодовых правок не потребовалось — регрессия была в том, что сервер не стартовал до 05 A1.

## Цель

1. Вернуть видимость «рассуждений» модели в режиме thinking: сейчас стримится, но в UI не показывается. **Не резать** — пользователь готов видеть 2+ экрана размышлений.
2. Вернуть видимость автономного режима: сейчас в UI приходит **только финальная сводка**, не видно как агент думал и какие тулзы звал. Нужен пошаговый стрим (thinking + tool-calls + tool-results) аналогично обычному чату.
3. Починить навигацию — из `/memory` сейчас невозможно выйти иначе как через URL-бар. Добавить постоянные ссылки в левую панель на всех страницах.
4. **Редизайн всего `web/app/` через frontend-design skill** (`frontend-design:frontend-design`). Нынешний UI минимальный и кривой; желательно переписать целиком: современный дизайн, не AI-generic, единый layout, страницы chat / memory / freelance / autonomous-viewer / logs.

## Приоритет
Пункты 1–3 — быстрые точечные фиксы. Пункт 4 (редизайн) — отдельный большой кусок **после** стабилизации бэкенда (см. [05-post-refactor-feedback.md](05-post-refactor-feedback.md), секция A). Не начинать, пока не работают запуск и контекст чата.

## Баг 1 — thinking не виден

### Диагностика

Подозрительные места (проверять в таком порядке):

1. **Фронт — парсер SSE в `web/app/composables/useChat.ts`.**
   - Найти обработку `choices[].delta`. Почти наверняка обрабатывается только `delta.content`, а `delta.reasoning_content` или `delta.thinking` молча игнорируются.
2. **Провайдер — `packages/providers/src/nvidia.ts`.**
   - Grep по `reasoning`, `thinking`. Если поле выкидывается при сборке стрима — чинить тут.
3. **SSE-прокси — `packages/providers/src/stream-utils.ts:createProxyStream` / `packages/core/src/lib/sse.ts:sseResponse`.**
   - Не должен трогать payload (просто пересылает chunks), но проверить — вдруг парсит и отдаёт только content.
4. **Опциональная обёртка — `wrapStreamForChat` в `packages/server/packages/server/packages/server/src/routes/chat.ts`.**
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
- `packages/providers/src/nvidia.ts` — только если thinking теряется в провайдере
- `packages/server/packages/server/packages/server/src/routes/chat.ts` (`wrapStreamForChat` — накопление `reasoning_content` для персистенса)
- `tests/e2e/thinking.spec.ts` (новый)
- `tests/e2e/navigation.spec.ts` (новый)

## Баг 3 — автономный режим не отображается

### Симптом
В UI для автономного агента виден **только финальный summary**, нет ни thinking, ни tool-calls, ни промежуточных шагов.

### Диагностика
1. `packages/server/packages/server/packages/server/src/routes/autonomous.ts` (или аналог) — проверить, что эндпоинт отдаёт SSE пошагово, а не один JSON в конце.
2. `web/app/composables/useAutonomous.ts` (если есть) — парсинг SSE. Скорее всего читается только последний чанк.
3. `packages/agent/packages/agent/packages/agent/packages/agent/src/pipeline/agent-loop/stream.ts` — источник потока. Должен эмитить `step.thinking`, `step.tool_call`, `step.tool_result`, `step.done`.

### Фикс
- Расширить SSE-события автономного режима: на каждый шаг агента → отдельный чанк с типом (`thinking` / `tool_call` / `tool_result` / `final`).
- Фронт рендерит timeline шагов с раскрывающимися блоками (thinking — `<details>`, tool — результат в `<pre>` с лимитом высоты + «показать полностью»).

## Баг 4 — thinking обрезается

### Симптом
Даже в обычном чате thinking усечён (видимо, CSS `max-height` или JS truncate).

### Фикс
Убрать жёсткую обрезку. Рендерить целиком внутри `<details>` (свёрнуто по умолчанию). Если текст очень длинный — скролл внутри блока, но **не усечение текста**.

## Порядок исполнения

1. **Баг 2 (навигация)** — проще и снимает ежедневное раздражение.
2. **Баг 1 + Баг 4 (thinking)** — вместе, связанные.
3. **Баг 3 (автономный)** — после того как бэкенд автономки стабилен (см. 05 A1).
4. **Редизайн (пункт 4 цели)** — последним, большим PR через frontend-design skill.
