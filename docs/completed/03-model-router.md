# 03. Model Router + Rate Limiter

> Статус: ✅ Реализовано

## Цель

Маппинг «роль → конкретная модель NVIDIA NIM» + приоритетная очередь запросов для соблюдения лимита 40 RPM.

## Model Router

Клиент (VS Code) отправляет `model: "coder"` или `model: "teamlead"` → прокси подменяет на реальную модель NVIDIA.

### Маппинг ролей

> Источник истины — [`src/lib/model-map.ts`](../../src/lib/model-map.ts) (`MODEL_MAP` baseline) + [`src/lib/model-map/openai-compat-overrides.ts`](../../src/lib/model-map/openai-compat-overrides.ts) (runtime overrides). Снимок на 2026-04-25.

#### Baseline (как в `MODEL_MAP` literal, действует когда `OPENAI_COMPAT_ENABLED=false`)

| Виртуальная роль | Primary (provider)            | Fallback (provider)                                  |
| :--------------- | :---------------------------- | :--------------------------------------------------- |
| `teamlead`       | `MiniMax-M2.7` (minimax)      | `minimaxai/minimax-m2.7` (nvidia)                    |
| `coder`          | `MiniMax-M2.7` (minimax)      | `mistralai/devstral-2-123b-instruct-2512` (nvidia)   |
| `critic`         | `MiniMax-M2.7` (minimax)      | `moonshotai/kimi-k2-thinking` (nvidia)               |
| `flash`          | `MiniMax-M2.7` (minimax)      | `stepfun-ai/step-3.5-flash` (nvidia)                 |
| `chaos`          | `MiniMax-M2.7` (minimax)      | `mistralai/mistral-medium-3-instruct` (nvidia)       |
| `generalist`     | `MiniMax-M2.7` (minimax)      | `minimaxai/minimax-m2.7` (nvidia)                    |
| `memory`         | `gpt-5.1` (openai-compat)     | `MiniMax-M2.7` (minimax)                             |

#### Effective на проде (`OPENAI_COMPAT_ENABLED=true`)

`applyOpenAICompatOverrides` итерирует hard-coded `["teamlead","coder"]` и re-points primary на `gpt-5.5` через `openai-compat`; baseline primary становится fallback'ом (поверх original fallback'а который превращается в third-tier — но `MAX_FALLBACK_ATTEMPTS=1`, так что effective fallback chain = одно звено).

| Виртуальная роль | Primary (provider)            | Fallback (provider)         |
| :--------------- | :---------------------------- | :-------------------------- |
| `teamlead`       | `gpt-5.5` (openai-compat)     | `MiniMax-M2.7` (minimax)    |
| `coder`          | `gpt-5.5` (openai-compat)     | `MiniMax-M2.7` (minimax)    |
| `critic`         | `MiniMax-M2.7` (minimax)      | `moonshotai/kimi-k2-thinking` (nvidia) |
| `flash`          | `MiniMax-M2.7` (minimax)      | `stepfun-ai/step-3.5-flash` (nvidia)   |
| `chaos`          | `MiniMax-M2.7` (minimax)      | `mistralai/mistral-medium-3-instruct` (nvidia) |
| `generalist`     | `MiniMax-M2.7` (minimax)      | `minimaxai/minimax-m2.7` (nvidia)      |
| `memory`         | `gpt-5.1` (openai-compat)     | `MiniMax-M2.7` (minimax)               |

> **`generalist`** — broad-purpose default для `dynamic_tools` (`create_tool`) когда caller не указал модель. Добавлено 2026-04-25 чтобы пофиксить runtime "provider copilot not loaded" на 5 dynamic-tools (task_status_check, find_vacancies_alternative, rss_vacancy_finder, flru_hot_orders, project_monitor), ссылавшихся на `generalist` до того как он существовал.
>
> **`memory`** — hippocampus + night-cycle. Primary GPT-5.1 через CLIProxyAPI bridge → ChatGPT Pro; MiniMax-M2.7 fallback для cliproxy outage. НЕ затрагивается `applyOpenAICompatOverrides` (hard-coded list = `["teamlead","coder"]`), поэтому `memory.primary` остаётся `gpt-5.1` независимо от env.

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

## Sandbox guard для code_tools (2026-04-25)

`src/mcp/registry/code-mgmt.tools.ts` — handler'ы `create_code_tool` и `edit_code_tool` отвергают код с паттернами, заведомо ломающими Bun-Worker sandbox:

| Pattern | Why blocked |
| :--- | :--- |
| `\brequire\s*\(` | `require` is nulled at runtime in `code-tools/sandbox.ts` |
| `^\s*import\s+(?!type\b)` (multiline) | Static `import` parses as `import(...)` dynamic-call inside `new Function` body — SyntaxError |
| `\bfrom\s+["']node:` | `node:*` modules unavailable in Worker |
| `\bimport\s*\(\s*["']node:` | Dynamic `import("node:...")` — same reason; also blocked by sandbox regex |
| `\bfrom\s+["']child_process["']` | No shell access in Worker |

`import type {...}` is allowed (erased by transpiler). На violation — `{success:false, error:"sandbox_violation: <hint>"}` без записи в `code_tools` table.

## Решённые вопросы

- [x] Клиент явно указывает виртуальную модель (`coder`, `teamlead`), автоопределение — будущее (docs/06)
- [x] Health check — нет, 5xx/429 обрабатываются fallback + backoff
- [x] Модель недоступна → retry → fallback → 503 клиенту

## OpenAI-compat provider (CLIProxyAPI bridge)

Optional bridge to ChatGPT Pro via Codex OAuth — no OpenAI API credits.
Routed through a local `cliproxy` container (`docker-compose.yml`).
**Off by default** — `OPENAI_COMPAT_ENABLED=false`.

### Setup (one-time, on VPS)

CLIProxyAPI uses its OWN OAuth flow (`--codex-login`), separate from OpenAI's
standalone `@openai/codex` CLI. Auth lives in `/root/.cli-proxy-api/`, NOT
`/root/.codex/`.

1. On VPS, in `/opt/subbrain/`:
   ```bash
   mkdir -p cliproxy/auths
   cp cliproxy/config.example.yaml cliproxy/config.yaml
   ```
2. Generate an API key for subbrain ↔ cliproxy mutual auth:
   ```bash
   KEY=$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 32)
   sed -i "s|REPLACE_ME_WITH_OPENAI_COMPAT_API_KEY|$KEY|" cliproxy/config.yaml
   echo "OPENAI_COMPAT_API_KEY=$KEY" >> .env
   ```
3. Start cliproxy alone (subbrain depends on it but doesn't need it healthy):
   ```bash
   docker compose up -d cliproxy
   ```
4. Run the Codex device-flow login inside the container:
   ```bash
   docker compose exec cliproxy ./cli-proxy-api --codex-login --no-browser
   ```
   Copy the URL + code, sign in via your ChatGPT Pro account in any browser.
   Token is written to `/root/.cli-proxy-api/codex-<email>.json` inside the
   container, persisted to `cliproxy/auths/` on the host via bind mount.
5. Restart cliproxy to pick up the new credentials:
   ```bash
   docker compose restart cliproxy
   ```
6. Verify with `scripts/preflight-openai-compat.sh`.

### Activation

1. Set `OPENAI_COMPAT_ENABLED=true` in `.env`.
2. `docker compose restart subbrain` — picks up env, calls
   `applyOpenAICompatOverrides()` BEFORE `createProviders()` in
   `src/app/deps.ts`, so `collectRequiredProviders()` sees the
   `openai-compat` slot and instantiates the real provider.

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

The OAuth file in `cliproxy/auths/` carries a refresh token; CLIProxyAPI
refreshes the access token in-place. Volume is mounted read-write so the
refreshed token persists across container restarts.

### Image pinning

The compose file uses `eceasy/cli-proxy-api:latest` (Docker Hub mirror of
the official upstream `router-for-me/CLIProxyAPI`). After the first
successful pull, replace `:latest` with the SHA256 digest
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
