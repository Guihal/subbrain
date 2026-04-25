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

## OpenAI-compat provider (CLIProxyAPI bridge)

Optional bridge to ChatGPT Pro via Codex OAuth — no OpenAI API credits.
Routed through a local `cliproxy` container (`docker-compose.yml`).
**Off by default** — `OPENAI_COMPAT_ENABLED=false`.

### Setup (one-time, on VPS)

1. Install Codex CLI on the VPS, run `codex login` → populates `/root/.codex/auth.json`.
2. `chmod 600 /root/.codex/auth.json`.
3. Verify with `scripts/preflight-openai-compat.sh`.

### Activation

1. Set `OPENAI_COMPAT_ENABLED=true` in `.env`.
2. Optionally override `OPENAI_COMPAT_BASE_URL` / `OPENAI_COMPAT_API_KEY`.
3. `docker compose up -d` — pulls `ghcr.io/router-for-me/cliproxyapi:v6` and
   exposes `:8080` only inside the compose network (no host port).
4. Bootstrap order: `applyOpenAICompatOverrides()` runs **before**
   `createProviders()` in `src/app/deps.ts`, so `collectRequiredProviders()`
   sees the `openai-compat` slot and instantiates the real provider rather
   than the absent stub.

### Routing semantics

- Allowlist regex: `/^(gpt-5(?:[-.\d]|$)|o3(?:-|$)|o4(?:-|$)|codex-)/`.
  Matches `gpt-5`, `gpt-5.5`, `gpt-5-codex`, `o3-mini`, `o4-...`, `codex-*`.
  `gpt-4o` stays on Copilot.
- When enabled, `MODEL_MAP.teamlead` and `MODEL_MAP.coder` are re-pointed:
  `primary = "gpt-5.5" / openai-compat`, `fallback = original primary /
  original primaryProvider` (i.e. MiniMax → NVIDIA chain stays intact).
- Override is reversible (WeakMap snapshot) — flipping the flag back to
  `false` and re-running `applyOpenAICompatOverrides()` restores the
  original routes.
- Known overlap: `gpt-5-codex` is also a valid Copilot model ID. When
  `ENABLED=true`, requests for it go to cliproxy first; on failure the
  fallback chain (capped at `MAX_FALLBACK_ATTEMPTS=1`) hits MiniMax.

### Token refresh

`auth.json` carries a refresh token. CLIProxyAPI refreshes the access token
in-place; the volume is mounted `read_only: true` by default. For long-lived
runs, mount read-write so refresh can persist.

### Image pinning

The compose file pins `ghcr.io/router-for-me/cliproxyapi:v6`. After the
first successful pull on the VPS, replace the tag with the SHA256 digest
(`docker image inspect ... | grep RepoDigests`) for reproducibility.

### Rate limiting

`PROVIDER_RPM["openai-compat"] = 30` in `src/lib/model-router/constants.ts`.
The local cliproxy is not the bottleneck — chatgpt.com upstream RPM is
undocumented; 30 is conservative. Raise after one week without 429s.

### Secret hygiene

Echoed upstream bodies pass through `redactSecrets()` in `src/lib/errors.ts`
before being stored on `HttpError`/`ProviderError`. ghu_/ghp_/sk-/nvapi-/
Bearer tokens are stripped — these errors are then surfaced to clients
(chat route slices to ≤200 chars) so leaks would otherwise reach the UI.
