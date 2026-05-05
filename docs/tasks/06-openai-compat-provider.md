# PR: openai-compat провайдер (CLIProxyAPI / Codex OAuth → ChatGPT Pro)

Status: DONE (PR 28, merged c1154b1 on 2026-04-25)
Owner: AI subagent
Source: RLM cycle 2026-04-25 (plan 2 iter ok, impl 5 iter ok, see ~/vault/RLM/Daily/2026-04-25.md)

## Цель

Добавить провайдер `openai-compat` в ModelRouter — роутить через локальный CLIProxyAPI-контейнер на ChatGPT Pro-подписку (gpt-5/gpt-5.5/o3/codex-*) без OpenAI API кредитов. Сохранить fallback chain. Не нарушить subbrain-guardrails. Feature-флаг `OPENAI_COMPAT_ENABLED` по умолчанию **off** — нулевая регрессия baseline.

## Файлы

Новые:
- `packages/providers/src/openai-compat.ts` (≤ 30 LOC)
- `packages/core/packages/core/src/lib/model-map/openai-compat-overrides.ts` (≤ 60 LOC)
- `tests/providers/openai-compat.test.ts` (≤ 250 LOC)
- `tests/lib/errors-redact.test.ts` (≤ 30 LOC)
- `scripts/preflight-openai-compat.sh` (18 LOC, chmod +x)

Модифицируемые:
- `packages/core/packages/core/src/lib/errors.ts` — `redactSecrets()` + sanitize HttpError `.message` AND `.body`
- `packages/providers/src/nvidia.ts` — sanitize ProviderError `.message` AND `.body`
- `packages/core/packages/core/src/lib/model-map.ts` — расширить `ProviderName`, allowlist `detectProvider`, re-export
- `packages/providers/packages/server/src/index.ts` — ветка openai-compat в `createProviders()`
- `packages/providers/src/model-router/constants.ts` — `PROVIDER_RPM["openai-compat"] = 30`
- `packages/server/packages/server/packages/server/src/app/deps.ts` — `applyOpenAICompatOverrides()` ПЕРЕД `createProviders()`
- `docker-compose.yml` — сервис `cliproxy`
- `.env.example` — секция `OPENAI_COMPAT_*`
- `AGENTS.md` — секция "OpenAI-compat (optional)"
- `docs/completed/03-model-router.md` — раздел "OpenAI-compat provider"
- `CLAUDE.md` — подсекция "Optional OpenAI-compat bridge"

## Изменение (детально)

### 1. `packages/core/packages/core/src/lib/errors.ts` — secret redaction

```ts
const SECRET_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._\-]+/gi,
  /(?:api[_-]?key|authorization|token)\s*[:=]\s*["']?[A-Za-z0-9._\-]+["']?/gi,
  /\bghu_[A-Za-z0-9]{20,}\b/g,
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bsk-(?:ant-)?[A-Za-z0-9._\-]{20,}\b/g,
  /\bnvapi-[A-Za-z0-9._\-]{10,}\b/g,
];

export function redactSecrets(input: string): string {
  if (!input) return input;
  let out = input;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[REDACTED]");
  return out;
}

export class HttpError extends Error {
  readonly status: number;
  readonly body: string;
  readonly meta: { url: string; requestId?: string; parseError?: boolean };
  constructor(status: number, body: string, meta: { url: string; requestId?: string; parseError?: boolean }) {
    const safe = redactSecrets(body);
    super(`HTTP ${status} @ ${meta.url}: ${safe.slice(0, 200)}`);
    this.name = "HttpError";
    this.status = status;
    this.body = safe;       // store redacted full body
    this.meta = meta;
  }
}
```

### 2. `packages/providers/src/nvidia.ts` — ProviderError sanitize

```ts
import { redactSecrets } from "../lib/errors";

export class ProviderError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string) {
    const safe = redactSecrets(body);
    super(`Provider error ${status}: ${safe.slice(0, 200)}`);
    this.status = status;
    this.body = safe;
  }
}
```

### 3. `packages/core/packages/core/src/lib/model-map.ts` — widening + allowlist + re-export

```ts
export type ProviderName =
  | "nvidia" | "openrouter" | "copilot" | "minimax" | "openai-compat";

const OPENAI_COMPAT_PREFIXES =
  /^(gpt-5(?:[-.\d]|$)|o3(?:-|$)|o4(?:-|$)|codex-)/;

function detectProvider(model: string): ProviderName {
  if (process.env.OPENAI_COMPAT_ENABLED === "true" && OPENAI_COMPAT_PREFIXES.test(model))
    return "openai-compat";
  if (model.endsWith(":free") || model.startsWith("openrouter/")) return "openrouter";
  if (model.startsWith("MiniMax-") || model.startsWith("abab")) return "minimax";
  if (model.startsWith("nvidia/") || model.startsWith("mistralai/") ||
      model.startsWith("nv-mistralai/") || model.startsWith("minimaxai/")) return "nvidia";
  return "copilot";
}

export { applyOpenAICompatOverrides } from "./model-map/openai-compat-overrides";
```

Note: `gpt-5-codex` Copilot model overlaps allowlist при ENABLED=true — acceptable, fallback на minimax спасает; documented в `docs/completed/03-model-router.md`.

### 4. `packages/core/packages/core/src/lib/model-map/openai-compat-overrides.ts` — новый файл

```ts
import { MODEL_MAP, type ModelRoute } from "../model-map";

const ORIGINAL_ROUTES = new WeakMap<
  Record<string, ModelRoute>,
  Partial<Record<string, ModelRoute>>
>();

export function applyOpenAICompatOverrides(
  map: Record<string, ModelRoute> = MODEL_MAP,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const enabled = env.OPENAI_COMPAT_ENABLED === "true";
  let snapshots = ORIGINAL_ROUTES.get(map);
  if (!snapshots) { snapshots = {}; ORIGINAL_ROUTES.set(map, snapshots); }

  for (const role of ["teamlead", "coder"] as const) {
    const cur = map[role];
    if (!cur) continue;
    if (enabled) {
      if (cur.primaryProvider === "openai-compat") continue;
      if (!cur.primaryProvider)
        throw new Error(`applyOpenAICompatOverrides: role "${role}" has no primaryProvider`);
      snapshots[role] = { ...cur };
      map[role] = {
        primary: "gpt-5.5",
        primaryProvider: "openai-compat",
        fallback: cur.primary,
        fallbackProvider: cur.primaryProvider,
      };
    } else {
      if (snapshots[role]) { map[role] = snapshots[role]!; delete snapshots[role]; }
    }
  }
}
```

### 5. `packages/providers/src/openai-compat.ts` — новый файл

```ts
import { NvidiaProvider } from "./nvidia";

export class OpenAICompatProvider extends NvidiaProvider {
  constructor(baseUrl: string, apiKey: string, extraHeaders: Record<string, string> = {}) {
    super(baseUrl, apiKey, { ...extraHeaders, "X-Subbrain-Provider": "openai-compat" });
  }
}
```

### 6. `packages/providers/packages/server/src/index.ts` — добавить ветку openai-compat

```ts
// imports:
import { OpenAICompatProvider } from "./openai-compat";

// в createProviders, перед return (после minimax ветки):
let openaiCompat: LLMProvider;
if (required.has("openai-compat")) {
  const url = process.env.OPENAI_COMPAT_BASE_URL || "http://cliproxy:8080/v1";
  const key = process.env.OPENAI_COMPAT_API_KEY || "cliproxy-local";
  openaiCompat = new OpenAICompatProvider(url, key);
} else {
  openaiCompat = makeAbsentProvider("openai-compat");
}

// return:
return { nvidia, openrouter, copilot, minimax, "openai-compat": openaiCompat };
```

### 7. `packages/providers/src/model-router/constants.ts` — добавить ключ

```ts
export const PROVIDER_RPM: Record<ProviderName, number> = {
  nvidia: 40,
  openrouter: 200,
  copilot: 10,
  minimax: 20,
  // Cliproxy is local. Real bottleneck is ChatGPT Pro upstream RPM
  // (undocumented). 30 = conservative; raise after 1 week without 429.
  "openai-compat": 30,
};
```

Без этого `bunx tsc --noEmit` падает (Record exhaustive).

### 8. `packages/server/packages/server/src/app/deps.ts:200` — bootstrap pin

```ts
import { applyOpenAICompatOverrides } from "../lib/model-map";

// перед существующим:  const providers = await createProviders();
applyOpenAICompatOverrides();
const providers = await createProviders();
```

### 9. `docker-compose.yml` — сервис cliproxy

```yaml
services:
  cliproxy:
    image: ghcr.io/router-for-me/cliproxyapi:v6
    container_name: subbrain-cliproxy
    restart: unless-stopped
    expose: ["8080"]
    volumes:
      - type: bind
        source: /root/.codex/auth.json
        target: /app/auth.json
        read_only: true
    environment:
      - CLIPROXY_AUTH_TOKEN=${OPENAI_COMPAT_API_KEY:-cliproxy-local}
      - CLIPROXY_CODEX_AUTH_PATH=/app/auth.json
    healthcheck:
      test: ["CMD-SHELL", "wget -q --spider http://localhost:8080/v1/models || exit 1"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 30s

  subbrain:
    # ... existing ...
    depends_on:
      cliproxy:
        condition: service_started
```

### 10. `.env.example` — секция

```bash
# ─── OpenAI-compat (CLIProxyAPI / Codex OAuth → ChatGPT Pro) ───
# Routes gpt-5/gpt-5.5/o3/o4/codex-* through a local CLIProxyAPI container,
# which forwards to chatgpt.com using a ChatGPT Pro OAuth token. Off by default.
# Enable on VPS only after `codex login` populates /root/.codex/auth.json (chmod 600).
# OPENAI_COMPAT_ENABLED=false
# OPENAI_COMPAT_BASE_URL=http://cliproxy:8080/v1
# OPENAI_COMPAT_API_KEY=cliproxy-local
```

### 11. `scripts/preflight-openai-compat.sh` — новый файл

```bash
#!/usr/bin/env bash
set -euo pipefail
VPS_HOST="${VPS_HOST:-root@109.120.187.244}"
AUTH_PATH="${AUTH_PATH:-/root/.codex/auth.json}"
ssh "$VPS_HOST" "
  if [ ! -f '$AUTH_PATH' ]; then echo 'MISSING: $AUTH_PATH — run codex login on VPS first' >&2; exit 1; fi
  PERMS=\$(stat -c %a '$AUTH_PATH')
  if [ \"\$PERMS\" != '600' ]; then echo \"WRONG PERMS: \$PERMS (expected 600)\" >&2; exit 1; fi
  echo 'OK: auth.json present, perms 600'
"
```

После создания: `chmod +x scripts/preflight-openai-compat.sh`.

### 12. AGENTS.md / docs/completed/03-model-router.md / CLAUDE.md

`AGENTS.md` — добавить в секцию routing:
```markdown
### OpenAI-compat (optional)
When `OPENAI_COMPAT_ENABLED=true`, virtual roles `teamlead` and `coder` route
to `gpt-5.5` via a local CLIProxyAPI container (`http://cliproxy:8080/v1`),
which forwards to chatgpt.com using a ChatGPT Pro OAuth token. Fallback
remains MiniMax / NVIDIA. See `.env.example` and
`docs/completed/03-model-router.md`.
```

`docs/completed/03-model-router.md` — добавить раздел "OpenAI-compat provider (CLIProxyAPI bridge)" с:
- Setup (Codex CLI install + login + chmod 600 + verify)
- Activation (`.env` flag + `docker compose up -d`)
- Routing semantics (allowlist regex, 2-link fallback)
- Token refresh (auto in-place)
- Image pinning (SHA digest)
- Allowlist + known overlaps (`gpt-5-codex` Copilot collision documented)

`CLAUDE.md` — добавить в "Architecture: Virtual roles" подсекцию:
```markdown
**Optional OpenAI-compat bridge.** When `OPENAI_COMPAT_ENABLED=true`,
`teamlead`/`coder` re-point to `gpt-5.5` via a sidecar `cliproxy` container.
Activation logic in `applyOpenAICompatOverrides` (called once at bootstrap
before `createProviders`). Allowlist `gpt-5*/o3*/o4*/codex-*` only.
See `docs/completed/03-model-router.md`.
```

## Тесты

### `tests/providers/openai-compat.test.ts` (≤ 250 LOC)

Top-level imports — только types и helpers (NO `OpenAICompatProvider` top-level — bun mock.module не rebind cached transitive imports). Provider загружается через `freshProvider()` dynamic import после `mockHttp()`.

Mock signature: `(url, init?, opts?)` — signal читается из `opts.signal`, не `init.signal` (соответствует [packages/providers/src/nvidia.ts:65](packages/providers/src/nvidia.ts#L65)).

Кейсы:
1. `chat: posts to configured base URL` — POST `/v1/chat/completions`.
2. `chat: Bearer auth header`.
3. `chat: X-Subbrain-Provider: openai-compat` header.
4. `chatStream: returns ReadableStream`.
5. `chat: AbortSignal in OPTS cancels in-flight` — `expect(lastOpts?.signal).toBe(ctrl.signal)`.
6. `chat: 401 body NOT leak Bearer/ghu_` — assert `e.message` не содержит `/ghu_/` или `/Bearer ghu/`.
7. `listModels: passthrough /v1/models`.

`describe("model-map: detect + apply")` с `afterEach(() => delete process.env.OPENAI_COMPAT_ENABLED)`:
8. `detect: gpt-5.5 → openai-compat when ENABLED=true`.
9. `detect: gpt-4o stays on copilot when ENABLED=true` (allowlist excludes).
10. `apply: idempotent on/off, throws on missing primaryProvider` — local map, проверка reverse + WeakMap snapshot restore.
11. `real MODEL_MAP not polluted across tests` — `MODEL_MAP.teamlead.primaryProvider === "minimax"`.

`describe("bootstrap integration (real createProviders)")` с `afterEach` восстанавливающим env + applyOpenAICompatOverrides() **unconditional**:
12. `ENABLED=true → providers['openai-compat'] is OpenAICompatProvider instance` — реально вызывает `createProviders()`, assert `instanceof`.

Полный код — см. секцию 7 в ~/vault/RLM/Daily/2026-04-25.md.

### `tests/lib/errors-redact.test.ts`

```ts
import { describe, test, expect } from "bun:test";
import { redactSecrets, HttpError } from "../../src/lib/errors";

describe("redactSecrets", () => {
  test("strips Bearer + ghu_ + sk- + nvapi-", () => {
    const dirty = "auth Bearer ghu_aaaaaaaaaaaaaaaaaaaa and sk-1234567890abcdefghij and nvapi-zzzzzzzzzzzz";
    const clean = redactSecrets(dirty);
    expect(clean).not.toMatch(/ghu_/);
    expect(clean).not.toMatch(/sk-1/);
    expect(clean).not.toMatch(/nvapi-z/);
    expect(clean).toContain("[REDACTED]");
  });

  test("HttpError: BOTH .message AND .body redacted", () => {
    const e = new HttpError(401, '{"err":"Bearer ghu_aaaaaaaaaaaaaaaaaaaa"}', { url: "x" });
    expect(e.message).not.toMatch(/ghu_/);
    expect(e.body).not.toMatch(/ghu_/);
  });
});
```

## Приёмка

Команды (все должны проходить на финальном коммите):

```bash
cd /usr/projects/subbrain
bunx tsc --noEmit                                 # exit 0
bun test                                          # all green, no regression in count
bun test tests/providers/openai-compat.test.ts    # 12 кейсов pass
bun test tests/lib/errors-redact.test.ts          # 2 кейса pass

# File-cap проверка:
wc -l packages/providers/src/openai-compat.ts              # ≤ 30
wc -l packages/core/src/lib/model-map/openai-compat-overrides.ts # ≤ 60
wc -l tests/providers/openai-compat.test.ts       # ≤ 250

# Grep-проверки:
grep -q '"openai-compat":' packages/providers/src/model-router/constants.ts
grep -q 'OpenAICompatProvider' packages/providers/packages/server/src/index.ts
grep -q 'applyOpenAICompatOverrides' packages/server/packages/server/src/app/deps.ts
grep -q 'OPENAI_COMPAT_ENABLED' .env.example
grep -q 'cliproxy:' docker-compose.yml
grep -q 'redactSecrets' packages/core/src/lib/errors.ts
grep -q 'redactSecrets' packages/providers/src/nvidia.ts

# Нет raw fetch в новом коде:
grep -n 'fetch(' packages/providers/src/openai-compat.ts || echo "no raw fetch — OK"

# Preflight script executable:
test -x scripts/preflight-openai-compat.sh

# Default OFF regression: МAP.teamlead.primaryProvider stays "minimax"
bun -e 'import("./src/lib/model-map").then(m => { console.log(m.MODEL_MAP.teamlead.primaryProvider); process.exit(m.MODEL_MAP.teamlead.primaryProvider === "minimax" ? 0 : 1); })'
```

Все checkboxes:
- [ ] tsc clean
- [ ] full test suite green, не падает baseline
- [ ] 12 + 2 новых тестов pass
- [ ] file-cap соблюдён (3 файла под лимитами)
- [ ] grep-проверки все возвращают exit 0
- [ ] нет raw `fetch()` в новых файлах
- [ ] preflight script chmod +x
- [ ] OPENAI_COMPAT_ENABLED=false → MODEL_MAP.teamlead.primaryProvider остаётся "minimax"

## Не входит в scope

- Поднятие cliproxy на VPS (manual deploy после merge).
- Codex CLI login на VPS (manual после merge).
- 3-link fallback chain (требует поднять `MAX_FALLBACK_ATTEMPTS`, отдельный PR).
- UI настройки в web/.
- Multi-account load-balancing.
- Latency observability openai-compat vs copilot.
- Image SHA pinning (manual после первого pull на VPS).

## Конвенции

- Bun-only (`bun:test`, `Bun.file`).
- Elysia + TypeBox для validations (не Zod).
- Logger: `logger.info(stage, message, extra?)` — single-arg = bug.
- Все outbound HTTP через `packages/core/packages/core/src/lib/http-client.ts` (NvidiaProvider уже complies).
- Repository layer (PR 27) — раз SQL не трогаем, не релевантно.
- См. полный subbrain-guardrails в `.claude/skills/subbrain-guardrails/SKILL.md`.

## Полный план + impl

Полный документ с iterations history → ~/vault/RLM/Daily/2026-04-25.md
