# Задача 05 — Пост-рефакторный фидбэк (2026-04-21): бэкенд + промпты

Status: DONE (A1/A2/A3/A4/B4 закрыты; D1/D2 отложены)

Общее резюме от пользователя: **после рефакторинга PR 01-15 код стал чище, но система нерабочая**. Либо не запускается, либо запускается без корректного отображения (в частности, автономный режим не виден в web UI).

Этот файл — общий бэкенд/промпт-скоуп. UI-правки ушли в [04](04-web-ui-fixes.md), TG-поиск — в [02](02-telegram-polling.md), принудительный RAG/RLM для дайджестов — в [01](01-rag-for-telegram-reports.md).

## A. Критичное — «не работает»

### A1. Запуск / smoke
- Проверить, что сервер вообще стартует после refactor PR 01-15 (см. `docs/tasks/refactor/README.md`).
- Если стартует — пройтись по smoke-флоу: обычный чат, агентный чат, автономный режим, night-cycle, TG send.
- Симптом фронта автономки («не отображается») диагностируется в [04 Баг 3](04-web-ui-fixes.md), но первопричина может быть и на бэке — проверить до UI-правок.

### A2. Контекст чата теряется
В одном и том же чате — **и в обычном, и в агентном режиме** — модель не видит предыдущие сообщения (ни свои, ни пользователя).
- Грепать сборку messages в `packages/server/packages/server/packages/server/src/routes/chat.ts`, `AgentPipeline.execute`, `AgentLoop.run`.
- Проверить `normalizeMessages()` и загрузку истории чата из `chats` таблицы.
- Вероятная регрессия из PR про разнос `agent-pipeline` / `agent-loop` (потерялся шаг «подгрузи историю сессии перед main.ts»).
- Тест: `tests/chat-continuity.test.ts` — два последовательных POST в один `chat_id`, во втором запросе модель видит содержимое первого.

### A3. Критик не работает (таймаут)
- Почти наверняка упирается в scope-таймаут `tool-runner.ts` (`consult_*=20s`) либо общий HTTP timeout.
- Модели-критики (Copilot/NVIDIA) легко тратят 30-60s на rationale.
- Фикс: отдельный scope `critic_*` с таймаутом 120s, либо настраиваемый через env `CRITIC_TIMEOUT_MS=120000`.
- Место: `packages/agent/packages/agent/packages/agent/packages/agent/src/pipeline/agent-loop/tool-runner.ts` (scope-map), `packages/core/packages/core/src/lib/http-client.ts` (если оттуда дёргается).

### A4. Таймауты в целом слишком низкие
- NVIDIA NIM: **не стримится**, ответ прилетает целиком в конце — зато бесплатно. Текущие 60s default / 180s copilot недостаточны для длинных non-stream ответов.
- Поднять:
  - `packages/core/packages/core/src/lib/http-client.ts` default 60s → 180s.
  - Copilot streams 180s → 300s.
  - NVIDIA non-stream — отдельный scope 240s.
- Tool scopes (`packages/agent/packages/agent/packages/agent/packages/agent/src/pipeline/agent-loop/tool-runner.ts`):
  - `consult_*` 20s → 60s.
  - `critic_*` новый, 120s (см. A3).
  - default 5s → 10s.

## B. UX-мелочь на бэкенде

### B4. Дата/время агентам — UTC+3
- Сейчас в system prompt скорее всего UTC или отсутствует.
- Добавить: текущая дата/время в **Europe/Moscow (UTC+3)**, формат `2026-04-21 14:30 MSK (UTC+3)`.
- Место правки: `src/lib/system-prompt.ts` (или куда вынесен промпт-билдер). Также проверить `pre/exec-summary.ts` и `phases/pre.ts` — любая точка, где собирается system prompt.
- Тест: snapshot system prompt содержит «MSK» и корректное смещение.

## D. Промпты

### D1. Прогнать промпты через /task
- Все ключевые промпты — прогнать через `/task` на предмет «короче + точнее + не многословнее»:
  - teamlead, coder, critic
  - hippocampus extractor (`post/hippocampus.ts`)
  - night-cycle steps (PII-scrub / translate / compress / verify / dedup)
  - post-extractor (`POST_EXTRACTOR_MODEL`)
- Выносить все промпты в `src/prompts/*.md` (если ещё не вынесено) — облегчит итерацию.
- В промптах критика — явно указать «используй инструменты поиска перед вердиктом» (связка с C2 из 01).

### D2. Caveman-style для памяти
- Для записи в слои памяти (`shared_memory`, `memory.context/archive`) — использовать аналог `caveman` (см. `.claude/skills/caveman/`).
- Цель: **не экономия токенов, а экономия контекста** (чтобы в prompt влезало больше фактов).
- Применять на write-пути hippocampus — extractor пишет факты уже в сжатом формате.
- Read-путь не трогать: факты уже компактные, расширение не нужно.
- Перед внедрением — короткий эксперимент: сравнить «обычный» и «caveman» фактлист на 1-2 днях логов, замерить качество ответов агента на фактоидных вопросах. Если деградация — откатить.
- Backup оригинала (как в `caveman:compress`) — не нужен, исходник остаётся в `raw_log`.

## Приоритеты

1. **A1 + A2** — запуск и контекст чата. Без этого всё остальное бессмысленно.
2. **A3 + A4** — таймауты (критик + общие), иначе `/task` / arbitration / длинные non-stream ответы не работают.
3. **B4** — UTC+3 (5 минут работы).
4. **D1** — прогон промптов через /task.
5. **D2** — caveman для памяти (после D1, чтобы промпт экстрактора уже был причёсан).

UI-часть (04), TG-поиск (02), дайджест-RLM (01) — параллельные треки, разблокируются после A1+A2.

## Связанные таски
- [01-rag-for-telegram-reports.md](01-rag-for-telegram-reports.md) — секция 5 «Принудительный RLM-сбор перед дайджестом» (C2/C3 из изначального фидбэка).
- [02-telegram-polling.md](02-telegram-polling.md) — подпункт «MCP-тулза `telegram_search`» (C1).
- [04-web-ui-fixes.md](04-web-ui-fixes.md) — thinking не резать, автономный режим виден пошагово, редизайн через frontend-design (B1-B3).
- `docs/tasks/refactor/README.md` — источник регрессий A1/A2.
