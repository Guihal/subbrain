# 03. Model Router + Rate Limiter

> Статус: ✅ Реализовано

## Цель

Маппинг «роль → конкретная модель NVIDIA NIM» + приоритетная очередь запросов для соблюдения лимита 40 RPM.

## Model Router

Клиент (VS Code) отправляет `model: "coder"` или `model: "teamlead"` → прокси подменяет на реальную модель NVIDIA.

### Маппинг ролей

| Виртуальная модель (от клиента) | Реальная модель NVIDIA                    | Fallback                              |
| :------------------------------ | :---------------------------------------- | :------------------------------------ |
| `teamlead`                      | `deepseek-ai/deepseek-v3.2`               | `minimaxai/minimax-m2.7`              |
| `coder`                         | `mistralai/devstral-2-123b-instruct-2512` | `qwen/qwen3-coder-480b-a35b-instruct` |
| `critic`                        | `moonshotai/kimi-k2-thinking`             | `deepseek-ai/deepseek-v3.2`           |
| `generalist`                    | `qwen/qwen3-coder-480b-a35b-instruct`     | `minimaxai/minimax-m2.7`              |
| `flash`                         | `stepfun-ai/step-3.5-flash`               | —                                     |

> **Примечание:** `flash` = единый агент для pre/post-processing, компрессии и памяти (200B MoE).

## Rate Limiter

Глобальный лимит: **40 RPM** на весь API key.

### Приоритеты очереди

1. **Critical:** user-facing запросы (ответ пользователю)
2. **Normal:** фоновые задачи (post-processing, запись в память)
3. **Low:** автономный режим (свободное плавание)

### Стратегия

- Token bucket / sliding window (40 слотов в минуту)
- Low-priority задачи ждут, если очередь > 80% заполнена
- Backoff при 429 от NVIDIA

## Fallback-логика

- При ошибке 5xx → retry 1 раз с той же моделью
- При повторной ошибке → переключение на fallback-модель
- При исчерпании RPM → задача в очередь с уведомлением

## Связь с LLM Provider

Model Router **не знает** о NVIDIA напрямую. Он:

1. Принимает виртуальное имя модели (`coder`, `teamlead`)
2. Резолвит в конкретное имя модели (`deepseek-ai/deepseek-v3.2`)
3. Передаёт в `LLMProvider.chat()` / `chatStream()`

Это позволяет в будущем:

- Добавить второй провайдер (например, Ollama для локальных моделей)
- Роутить разные роли к разным провайдерам
- Подменить провайдер в тестах (mock)

## Реализация

- `src/lib/model-map.ts` — маппинг ролей + fallback таблица
- `src/lib/model-router.ts` — `ModelRouter` с fallback + retry
- `src/lib/rate-limiter.ts` — sliding window 40 RPM, 3 приоритета

## Решённые вопросы

- [x] Клиент явно указывает виртуальную модель (`coder`, `teamlead`), автоопределение — будущее (docs/06)
- [x] Health check — нет, 5xx/429 обрабатываются fallback + backoff
- [x] Модель недоступна → retry → fallback → 503 клиенту
