# Agent-teams task 01 — Phase 1 Bifrost gateway (Kimi packets)

**Status:** active decomposition (round-2 after Codex critic verdict `needs-fix`)
**Worker model:** Kimi K2.6 (`kimi-claude` launcher)
**Phase:** 1 (gateway side-car) — see `docs/specs/subbrain-main.md` § Phase 1
**Risk tier:** mostly `public-api`, never `db`/`security`
**Replaces:** previous round-1 6-packet draft (round-1 had unresolved TBDs and
incoherence between P1-1 yaml config and Bifrost actual JSON config)

## Operator pre-fill (resolved before dispatch)

These were `<TBD>` in round-1; round-2 resolves them with values verified against
upstream docs (`https://docs.getbifrost.ai/quickstart/gateway/setting-up`,
`https://github.com/maximhq/bifrost`). Worker treats them as facts, not guesses:

| Token | Resolved value | Source |
|---|---|---|
| `<BIFROST_IMAGE>` | `maximhq/bifrost:latest` | upstream README docker run example |
| `<BIFROST_HTTP_PORT>` | `8080` | upstream README docker run example |
| `<BIFROST_INTERNAL_URL>` | `http://bifrost:8080` | compose service name `bifrost` + port |
| `<BIFROST_CONFIG_FORMAT>` | **JSON** (not yaml) | upstream config has `$schema` field, mounted at `/app/data` as `config.json` |
| `<BIFROST_CONFIG_MOUNT>` | `/app/data` (app-dir) | upstream quickstart "the volume you mount will be used as the app-dir" |
| `<BIFROST_CHAT_PATH>` | `/v1/chat/completions` | upstream quickstart "unified endpoint" |
| `<BIFROST_ENV_REF>` | `env.VAR_NAME` (string literal) | upstream config example uses `"value": "env.OPENAI_API_KEY"` |

**Genuinely unresolved (kept as escalation triggers):**

- **Custom OpenAI-compatible provider shape** — Bifrost upstream docs show
  `openai`/`anthropic` provider keys, but do not document the `base_url`
  override needed for NVIDIA NIM (`https://integrate.api.nvidia.com/v1`) and
  the local `cliproxy:8317` bridge in the small set of pages we fetched.
  Round-1's "minimal config covering MiniMax + NVIDIA only" is therefore not a
  drop-in: Bifrost may or may not accept a `base_url` field on the `openai`
  provider type, or may require a custom `provider_type`. **P1-1 ships only
  the side-car + env wiring + an empty `providers: {}` placeholder**; populating
  the providers map is deferred to P1-6 where the worker either (a) confirms
  the upstream schema for custom base_urls and writes the full 4-provider
  config or (b) escalates `FAIL: upstream-docs:custom-base-url-shape`.
- **OpenAI-compat parity for cliproxy** — see P1-6 for the same reason;
  cliproxy in compose is on port `8317`, not `8080` (verified from
  `docker-compose.yml:9`).

## Phase goal

Move LLM routing/fallback/rate-limit/cost concerns out of `src/lib/model-router/*`
and into a Bifrost LLM-gateway side-car, **behind a feature flag**, **without
deleting the existing router**. Parity bridge first, replacement later.

Embeddings + rerank stay on the raw NVIDIA path (`router.raw` / `scheduleRaw`).
Bifrost only owns chat + chat-stream.

## Architectural decisions locked in this round (no worker discretion)

These resolve the round-1 critic findings; workers must NOT redesign them:

1. **Virtual-role mapping ownership.** Subbrain keeps virtual roles
   (`teamlead`/`coder`/...) in `src/lib/model-map.ts`. Bifrost only knows
   provider names + their API keys + their rate limits. Subbrain resolves
   `role → {provider, model}` first, then forwards `model` (the real model
   string) to Bifrost. Bifrost is a transport gateway, not a role registry.
2. **Bifrost injection point.** `BifrostProvider` is **NOT** added to
   `ProviderName` union in `src/lib/model-map.ts` and **NOT** stored in the
   `ModelRouter.backends: Record<ProviderName, Backend>` map. Instead,
   `ModelRouter` gets a new optional private field `private bifrost?:
   BifrostProvider`, populated in the constructor only when
   `process.env.BIFROST_ENABLED === "true"` AND env URL/key are present. This
   is the **less-invasive** option: zero changes to `ProviderName`, zero
   changes to `RateLimiter.PROVIDER_RPM`, zero changes to the `backends` map
   shape. Constructor signature gains an optional second arg
   `bifrost?: BifrostProvider` (additive, default `undefined`).
3. **Embed/rerank stay raw NVIDIA.** Bifrost only proxies chat + chat-stream.
   `BifrostProvider.embed/rerank/listModels` throw with explicit
   "use raw NVIDIA path" message. `ModelRouter.scheduleRaw` and
   `ModelRouter.raw` are unchanged.
4. **Fallback semantics when `BIFROST_ENABLED=true`.** If Bifrost call fails
   (network error, 5xx, 429, auth), the existing `runChatDispatch` /
   `createFallbackStream` machinery is **NOT** invoked as a second-level
   fallback. Bifrost owns provider fallback internally; if Bifrost itself is
   unreachable or misconfigured, surface `UpstreamExhaustedError` (matches
   existing capped-fallback semantics). Direct-mode (`X-Direct-Mode: true`
   header in `src/services/chat/*`) remains the **only** operator-triggered
   bypass and routes to the legacy path; Bifrost is not in that path.
5. **Heartbeat owner is unchanged by this phase.** The `: ping\n\n` heartbeat
   currently lives **only** in `src/pipeline/agent-loop/heartbeat.ts`
   (consumed by `src/pipeline/agent-loop/stream.ts`) and
   `src/mcp/mcp-protocol.ts`. The chat SSE path
   (`src/services/chat/sse-wrap.ts` + `src/services/chat/run.ts`) currently
   relies on `idleTimeout: 255` set in `src/index.ts:19` only. Phase 1 does
   not add or move heartbeats. If a worker discovers a new heartbeat is
   needed, that is **out of scope** — `FAIL: scope`.
6. **P1-6 is mandatory for Phase 1 completion**, not optional. Round-1
   marked it optional, but `docs/specs/subbrain-main.md:411` explicitly
   states the Phase 1 work item is "Add minimal config for MiniMax, NVIDIA,
   OpenRouter, openai-compat" — all four. Phase 1 MVP gate = P1-1..P1-6 all
   green. P1-6 is sequenced last because it depends on P1-1 ground-floor +
   P1-2..P1-5 proving the provider shape works for the simple case.

## Packet ordering & dependency notes

The phase is split into 6 self-contained packets sized for one Kimi pass each
(`diff_budget_loc < 300`, `file_count_max ≤ 4`). Packet count unchanged from
round-1; content rewritten to fix critic findings.

```
P1-1 compose side-car + env flag + empty config.json    (no src/ touch)
   └─ P1-2 BifrostProvider non-stream chat
        └─ P1-3 BifrostProvider streaming SSE path
             └─ P1-4 router feature-flag wiring (additive constructor arg)
                  └─ P1-5 fallback / cancel / auth-error tests
                       └─ P1-6 fill providers in config.json (4 providers) + parity test
```

P1-2 and P1-3 must land in this order (`chatStream` reuses helpers from `chat`).
P1-4 must wait for both P1-2 and P1-3 — partial wiring would degrade streaming.
P1-5 is split out so the test packet stays under the LOC budget.
P1-6 fills the providers map and proves parity; without it Phase 1 is incomplete.

## Universal hard non-goals (applied to every packet below)

Every packet `non_goals` repeats these because the spec demands it:

1. Do not remove or rewrite `src/lib/model-router/*` (parity must be proven first).
2. Do not introduce a DB-driven model editor or any DB migration.
3. Do not add a roles UI or any frontend change.
4. Do not break direct mode (`X-Direct-Mode: true` header path in
   `src/services/chat/*` — must keep working with `BIFROST_ENABLED=false`).
5. Do not change provider rate-limiter behavior visible to clients
   (`src/lib/rate-limiter.ts` semantics, `PROVIDER_RPM` numbers, `429` backoff).
6. Do not change `MODEL_MAP` role assignments, embed model, or rerank model.
7. Do not add `bifrost` to the `ProviderName` union in `src/lib/model-map.ts`.
8. Do not run `docker compose build/up`, do not read `.env` at packet time, do
   not push commits.
9. Do not add new dependencies to `package.json` (use `Bun.file().json()` /
   `JSON.parse` for config; `Bun.YAML` / external `yaml`/`js-yaml` packages
   are NOT needed because Bifrost config is JSON).

## Universal guardrails (CLAUDE.md echoes)

- Outbound HTTP only via `src/lib/http-client.ts` (`fetchJson` / `fetchStream`).
- Fan-out concurrency via `Promise.allSettled`, not `Promise.all`.
- Threading: every chat/stream entry receives `params.signal?: AbortSignal`,
  forwarded to `fetchJson` / `fetchStream`. Pre-flight `signal.aborted` check
  before first network call (matches `NvidiaProvider.chat` at
  `src/providers/nvidia.ts:50-51`).
- Logger contract: `logger.info("bifrost", "...", extra?)` — three-arg form
  only (CLAUDE.md guardrail #9).
- Errors: map upstream non-2xx to `ProviderError(status, body)` (definition at
  `src/providers/nvidia.ts:155-165`, re-exported via `src/providers/index.ts:14`).
  Never echo upstream body > 200 chars; `ProviderError` constructor itself runs
  `redactSecrets` from `src/lib/errors.ts`.
- File caps: every new TS file ≤ 150 LOC (`scripts/check-file-size.ts` enforces;
  template `src/providers/nvidia.ts` shape, currently 153 lines but legacy-
  whitelisted).

---

## Packet P1-1 — compose side-car + env flag + empty config skeleton

```json
{
  "task_id": "P1-1",
  "goal": "Add Bifrost side-car service to docker-compose.yml with an empty-providers config.json skeleton and BIFROST_ENABLED=false default in .env.example.",
  "non_goals": [
    "Do not touch any file under src/.",
    "Do not populate the providers map in config.json — P1-6 fills it after schema is verified.",
    "Do not remove or modify the existing cliproxy service block in docker-compose.yml.",
    "Do not change MODEL_MAP, embed/rerank, or rate-limiter semantics.",
    "Do not break X-Direct-Mode header path.",
    "Do not run docker compose build/up; only static config validation.",
    "Do not add a yaml/js-yaml dependency — config is JSON; use JSON.parse / Bun.file().json().",
    "Do not add bifrost to the ProviderName union (src/lib/model-map.ts:6).",
    "Do not commit any real API key value into config.json — use the env.VAR_NAME literal string syntax."
  ],
  "allowed_write_paths": [
    "docker-compose.yml",
    ".env.example",
    "bifrost/config.json",
    "bifrost/data/.gitkeep"
  ],
  "read_context": [
    "docker-compose.yml",
    ".env.example",
    "docs/specs/subbrain-main.md:404-424",
    "docs/tasks/agent-teams/01-bifrost-gateway.md:operator-pre-fill section",
    "src/lib/model-map.ts:1-30"
  ],
  "risk_tier": "public-api",
  "acceptance": [
    "docker compose -f docker-compose.yml config --quiet",
    "test -f bifrost/config.json && bun -e 'const c = await Bun.file(\"bifrost/config.json\").json(); if (!c.providers || typeof c.providers !== \"object\") throw new Error(\"providers key missing\")'",
    "grep -q '^BIFROST_ENABLED=false$' .env.example",
    "grep -q '^BIFROST_BASE_URL=http://bifrost:8080$' .env.example",
    "grep -q '^BIFROST_API_KEY=' .env.example",
    "grep -q 'image: maximhq/bifrost:latest' docker-compose.yml",
    "grep -q 'container_name: subbrain-bifrost' docker-compose.yml",
    "wc -l bifrost/config.json | awk '{ exit ($1 <= 50) ? 0 : 1 }'",
    "bunx tsc --noEmit",
    "bun run scripts/check-file-size.ts",
    "bun run scripts/check-deep-imports.ts"
  ],
  "diff_budget_loc": 80,
  "file_count_max": 4,
  "rollback": "git restore docker-compose.yml .env.example && rm -rf bifrost/",
  "escalation_triggers": [
    "Upstream Bifrost image tag maximhq/bifrost:latest unreachable on docker pull dry-run — STOP with FAIL: upstream-docs:image-unavailable.",
    "docker compose config refuses the new service (yaml/schema error, port collision on 8080, volume name collision) — STOP with FAIL: precheck.",
    "Adding the side-car requires touching cliproxy or subbrain service blocks — STOP with FAIL: scope.",
    "Spec contradicts existing compose file (e.g. another service already binds port 8080) — STOP with FAIL: precheck.",
    "Operator-pre-fill table at the top of this doc is missing or empty — STOP with FAIL: precheck:pre-fill-missing."
  ],
  "glossary": {
    "Bifrost side-car": "Container running maximhq/bifrost:latest, exposed only on the compose internal network (no host port mapping). Subbrain reaches it via http://bifrost:8080/v1/chat/completions.",
    "BIFROST_ENABLED": "Env flag, default false. When false the existing src/lib/model-router/* path stays active end-to-end.",
    "empty-providers config": "bifrost/config.json must include the $schema URL and providers: {} (empty object). P1-6 fills it.",
    "env.VAR_NAME literal": "Bifrost-specific config syntax: providers[*].keys[*].value = 'env.NVIDIA_API_KEY' (string starting with 'env.') tells Bifrost to read the env var at runtime. Do NOT substitute the actual value.",
    "config mount": "Volume bind: ./bifrost on host → /app/data inside the container. Bifrost reads /app/data/config.json automatically (per upstream quickstart).",
    "deployment sequence (after P1-1 merge, ops-only, NOT executed by worker)": "1) Set BIFROST_API_KEY in .env on host. 2) docker compose pull bifrost. 3) docker compose up -d bifrost. 4) curl http://127.0.0.1:8080/health (if port forwarded for debug) — but default is internal-only, verify via 'docker compose exec subbrain bun -e ...'. None of these steps are part of the P1-1 packet acceptance."
  }
}
```

### Reference scaffold (P1-1)

`bifrost/config.json` (literal contents — worker must use exactly this):

```json
{
  "$schema": "https://www.getbifrost.ai/schema",
  "providers": {},
  "config_store": {
    "enabled": true,
    "type": "sqlite",
    "config": { "path": "/app/data/config.db" }
  }
}
```

`docker-compose.yml` add-on (literal — worker must add exactly this block under
`services:`, alphabetical position with other services is irrelevant):

```yaml
  bifrost:
    image: maximhq/bifrost:latest
    container_name: subbrain-bifrost
    restart: unless-stopped
    expose: ["8080"]
    env_file: [.env]
    volumes:
      - type: bind
        source: ./bifrost
        target: /app/data
```

`.env.example` add-on (append three lines):

```
BIFROST_ENABLED=false
BIFROST_BASE_URL=http://bifrost:8080
BIFROST_API_KEY=changeme-bifrost-master-key
```

`bifrost/data/.gitkeep` is an empty file so the directory exists for the bind
mount on a fresh checkout.

---

## Packet P1-2 — BifrostProvider (non-streaming chat)

```json
{
  "task_id": "P1-2",
  "goal": "Add src/providers/bifrost.ts implementing LLMProvider.chat() against the Bifrost OpenAI-compatible HTTP endpoint, plus a unit test for payload shape and ProviderError mapping.",
  "non_goals": [
    "Do not implement chatStream() in this packet — P1-3 handles it (throw 'not implemented in P1-2' for now).",
    "Do not implement embed/rerank — throw with explicit 'use raw NVIDIA path' message; embed/rerank stays on raw NVIDIA per Phase 1 architectural decision #3.",
    "Do not register the provider in src/providers/index.ts (P1-4 wires it).",
    "Do not modify src/lib/model-router.ts in this packet.",
    "Do not modify src/lib/model-map.ts (BifrostProvider is NOT a ProviderName entry).",
    "Do not change MODEL_MAP, rate-limiter, or direct-mode behavior.",
    "Do not add new dependencies to package.json.",
    "Do not add an idle-stream heartbeat — the chat SSE path heartbeat owner is unchanged (architectural decision #5)."
  ],
  "allowed_write_paths": [
    "src/providers/bifrost.ts",
    "tests/bifrost-provider.test.ts"
  ],
  "read_context": [
    "src/providers/types.ts",
    "src/providers/nvidia.ts:1-100",
    "src/providers/nvidia.ts:155-165",
    "src/lib/http-client.ts",
    "src/lib/errors.ts"
  ],
  "risk_tier": "public-api",
  "acceptance": [
    "bunx tsc --noEmit",
    "bun test tests/bifrost-provider.test.ts",
    "grep -q 'fetchJson' src/providers/bifrost.ts",
    "grep -q 'params.signal' src/providers/bifrost.ts",
    "grep -q 'ProviderError' src/providers/bifrost.ts",
    "wc -l src/providers/bifrost.ts | awk '{ exit ($1 <= 150) ? 0 : 1 }'",
    "wc -l tests/bifrost-provider.test.ts | awk '{ exit ($1 <= 150) ? 0 : 1 }'",
    "bun run scripts/check-file-size.ts",
    "bun run scripts/check-deep-imports.ts"
  ],
  "diff_budget_loc": 220,
  "file_count_max": 2,
  "rollback": "git rm src/providers/bifrost.ts tests/bifrost-provider.test.ts",
  "escalation_triggers": [
    "Bifrost upstream non-OpenAI-compatible request shape (verified via test against a Bun.serve mock) — STOP with FAIL: upstream-docs.",
    "LLMProvider interface in src/providers/types.ts changed since this contract was written (chat signature differs from src/providers/nvidia.ts:49) — STOP with FAIL: precheck.",
    "ProviderError export path moved off src/providers/nvidia.ts:155 (e.g. relocated to src/lib/errors.ts) — STOP with FAIL: precheck.",
    "Implementation requires touching ModelRouter or any model-router/* file — STOP with FAIL: scope.",
    "Spec contradicts code (e.g. read_context line ranges no longer match actual file contents) — STOP with FAIL: precheck:spec-mismatch."
  ],
  "glossary": {
    "BifrostProvider": "Class implementing LLMProvider; constructor(baseUrl: string, apiKey: string). NOT registered in ProviderName union — passed into ModelRouter via a new optional constructor arg in P1-4.",
    "OpenAI-compatible payload": "POST {baseUrl}/v1/chat/completions with body { model, messages, temperature?, max_tokens?, top_p?, tools?, tool_choice?, stream: false }, Authorization: 'Bearer ${apiKey}'. Path is exactly /v1/chat/completions per upstream quickstart.",
    "ProviderError mapping": "On non-2xx, throw `new ProviderError(status, body)` from src/providers/nvidia.ts:155. ProviderError constructor itself runs redactSecrets and slices body to 200 chars — do NOT pre-redact in BifrostProvider.",
    "use raw NVIDIA path message": "embed/rerank/listModels throw new Error('bifrost does not proxy embed/rerank — use ModelRouter.scheduleRaw / .raw for NVIDIA NIM directly')."
  }
}
```

### Required shape (P1-2)

```ts
// src/providers/bifrost.ts (≤150 LOC)
import { HttpError } from "../lib/errors";
import { fetchJson } from "../lib/http-client";
import { ProviderError } from "./nvidia";
import type { ChatParams, ChatResponse, EmbedParams, EmbedResponse,
  LLMProvider, ModelInfo, RerankParams, RerankResponse } from "./types";

export class BifrostProvider implements LLMProvider {
  constructor(private baseUrl: string, private apiKey: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }
  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    };
  }
  async chat(params: ChatParams): Promise<ChatResponse> {
    if (params.signal?.aborted) {
      throw params.signal.reason ?? new DOMException("Aborted", "AbortError");
    }
    try {
      return await fetchJson<ChatResponse>(
        `${this.baseUrl}/v1/chat/completions`,
        {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify({ ...params, stream: false }),
        },
        { timeoutMs: 240_000, signal: params.signal },
      );
    } catch (e) {
      if (e instanceof HttpError) throw new ProviderError(e.status, e.body);
      throw e;
    }
  }
  chatStream(_p: ChatParams): ReadableStream<Uint8Array> {
    throw new Error("BifrostProvider.chatStream — implemented in P1-3");
  }
  embed(_p: EmbedParams): Promise<EmbedResponse> {
    throw new Error("bifrost does not proxy embed/rerank — use ModelRouter.scheduleRaw / .raw for NVIDIA NIM directly");
  }
  rerank(_p: RerankParams): Promise<RerankResponse> {
    throw new Error("bifrost does not proxy embed/rerank — use ModelRouter.scheduleRaw / .raw for NVIDIA NIM directly");
  }
  async listModels(): Promise<ModelInfo[]> { return []; }
}
```

Test must cover:

- payload shape (model + messages + stream:false; URL ends with `/v1/chat/completions`),
- Bearer header present,
- 401/403/429/5xx → `ProviderError(status, body)`,
- redaction of API key in error body (assert no raw `Bearer sk-...` substring in `err.body`),
- `signal.aborted` pre-flight throws DOMException without making a network call (use a mock `fetch` that records call count = 0).

---

## Packet P1-3 — BifrostProvider streaming SSE path

```json
{
  "task_id": "P1-3",
  "goal": "Implement BifrostProvider.chatStream() returning ReadableStream<Uint8Array> via fetchStream + createProxyStream, preserving AbortSignal threading.",
  "non_goals": [
    "Do not modify src/services/chat/run.ts, src/services/chat/sse-wrap.ts, or src/index.ts (idleTimeout owner).",
    "Do not modify src/providers/stream-utils.ts or src/providers/sse-parser.ts.",
    "Do not add a heartbeat ping inside the provider — the chat SSE path heartbeat owner is unchanged (architectural decision #5; existing : ping lives only in src/pipeline/agent-loop/heartbeat.ts and src/mcp/mcp-protocol.ts).",
    "Do not register the provider in src/providers/index.ts (P1-4).",
    "Do not change rate-limiter or direct-mode behavior.",
    "Do not change embed/rerank or MODEL_MAP."
  ],
  "allowed_write_paths": [
    "src/providers/bifrost.ts",
    "tests/bifrost-stream.test.ts"
  ],
  "read_context": [
    "src/providers/nvidia.ts:69-84",
    "src/providers/stream-utils.ts",
    "src/lib/http-client.ts",
    "src/services/chat/sse-wrap.ts",
    "src/services/chat/run.ts"
  ],
  "risk_tier": "public-api",
  "acceptance": [
    "bunx tsc --noEmit",
    "bun test tests/bifrost-stream.test.ts",
    "grep -q 'createProxyStream' src/providers/bifrost.ts",
    "grep -q 'fetchStream' src/providers/bifrost.ts",
    "grep -q 'params.signal' src/providers/bifrost.ts",
    "wc -l src/providers/bifrost.ts | awk '{ exit ($1 <= 150) ? 0 : 1 }'",
    "wc -l tests/bifrost-stream.test.ts | awk '{ exit ($1 <= 150) ? 0 : 1 }'",
    "bun run scripts/check-file-size.ts",
    "bun run scripts/check-deep-imports.ts"
  ],
  "diff_budget_loc": 200,
  "file_count_max": 2,
  "rollback": "git checkout HEAD -- src/providers/bifrost.ts && git rm tests/bifrost-stream.test.ts",
  "escalation_triggers": [
    "createProxyStream signature changed since this contract — STOP with FAIL: precheck.",
    "Implementation requires modifying any heartbeat owner (src/pipeline/agent-loop/heartbeat.ts, src/mcp/mcp-protocol.ts, src/index.ts) — STOP with FAIL: scope.",
    "Implementation requires modifying providers/stream-utils.ts — STOP with FAIL: scope.",
    "Bun fetchStream cannot thread signal — STOP with FAIL: precheck.",
    "Spec contradicts code (read_context line ranges no longer match actual file contents) — STOP with FAIL: precheck:spec-mismatch."
  ],
  "glossary": {
    "Streaming shape": "Mirror NvidiaProvider.chatStream lines 69-84 verbatim, swap baseUrl/headers, keep timeoutMs: 180_000 + signal: params.signal. URL ends with /v1/chat/completions.",
    "wrapStreamForChat compatibility": "The returned ReadableStream<Uint8Array> must emit raw OpenAI SSE bytes ('data: {...}\\n\\n', terminated by 'data: [DONE]\\n\\n') so wrapStreamForChat (src/services/chat/sse-wrap.ts:9) parses chunks unchanged. Bifrost is OpenAI-compatible so this is automatic.",
    "Heartbeat ownership": "Phase 1 does not introduce a heartbeat in the chat SSE path. The autonomous agent-loop has its own heartbeat in src/pipeline/agent-loop/heartbeat.ts; MCP transport has its own in src/mcp/mcp-protocol.ts:65. Chat SSE relies on Bun idleTimeout: 255 set in src/index.ts:19. Do not touch any of these."
  }
}
```

### Required shape (P1-3)

Append to `src/providers/bifrost.ts` (replace the throw stub from P1-2):

```ts
import { fetchStream } from "../lib/http-client";
import { createProxyStream } from "./stream-utils";
// ... inside class:
chatStream(params: ChatParams): ReadableStream<Uint8Array> {
  const url = `${this.baseUrl}/v1/chat/completions`;
  const headers = this.headers();
  const body = JSON.stringify({ ...params, stream: true });
  return createProxyStream(() => {
    if (params.signal?.aborted) {
      throw params.signal.reason ?? new DOMException("Aborted", "AbortError");
    }
    return fetchStream(
      url,
      { method: "POST", headers, body },
      { timeoutMs: 180_000, signal: params.signal },
    );
  });
}
```

Test must cover: SSE chunks proxied byte-for-byte (use Bun.serve fixture
emitting `data: {"choices":[...]}\n\n` followed by `data: [DONE]\n\n`),
AbortController propagation (caller cancels mid-stream → `fetchStream` aborts;
no further bytes enqueued after cancel), upstream 5xx mid-stream mapped to
error chunk via createProxyStream's existing behaviour.

---

## Packet P1-4 — router feature-flag wiring (additive constructor arg)

```json
{
  "task_id": "P1-4",
  "goal": "Add an optional bifrost?: BifrostProvider parameter to ModelRouter constructor and an early-branch in chat() / chatStream() that routes through it when process.env.BIFROST_ENABLED === 'true', without touching backends map or ProviderName union.",
  "non_goals": [
    "Do not delete any code in src/lib/model-router/* — only add an early-branch in ModelRouter.chat / ModelRouter.chatStream.",
    "Do not change scheduleRaw, raw, isOverloadedFor, or stats getters.",
    "Do not add bifrost to the ProviderName union in src/lib/model-map.ts:6.",
    "Do not add bifrost to PROVIDER_RPM in src/lib/model-router/constants.ts.",
    "Do not store BifrostProvider in this.backends — use a separate private field this.bifrost.",
    "Do not change MODEL_MAP role mappings.",
    "Do not break X-Direct-Mode behavior in src/services/chat — flag-off path is byte-identical to current behavior.",
    "Do not delete .env.example BIFROST_* keys (added by P1-1).",
    "Do not invoke runChatDispatch / createFallbackStream as a second-level fallback when the Bifrost path errors (architectural decision #4)."
  ],
  "allowed_write_paths": [
    "src/lib/model-router.ts",
    "src/providers/index.ts",
    "src/app/deps.ts"
  ],
  "read_context": [
    "src/lib/model-router.ts",
    "src/lib/model-router/dispatch.ts",
    "src/lib/model-router/stream.ts",
    "src/providers/index.ts",
    "src/providers/bifrost.ts",
    "src/app/deps.ts"
  ],
  "risk_tier": "public-api",
  "acceptance": [
    "bunx tsc --noEmit",
    "bun test tests/model-router.test.ts",
    "grep -q 'BIFROST_ENABLED' src/lib/model-router.ts",
    "grep -q 'BifrostProvider' src/providers/index.ts",
    "grep -q 'private bifrost' src/lib/model-router.ts",
    "wc -l src/lib/model-router.ts | awk '{ exit ($1 <= 150) ? 0 : 1 }'",
    "wc -l src/providers/index.ts | awk '{ exit ($1 <= 175) ? 0 : 1 }'",
    "bun run scripts/check-file-size.ts",
    "bun run scripts/check-deep-imports.ts"
  ],
  "diff_budget_loc": 150,
  "file_count_max": 3,
  "rollback": "git checkout HEAD -- src/lib/model-router.ts src/providers/index.ts src/app/deps.ts",
  "escalation_triggers": [
    "ModelRouter chat/chatStream branch cannot be added without pushing src/lib/model-router.ts past 150 lines — STOP with FAIL: scope:file-cap (parent must split-file or raise budget in a follow-up packet).",
    "Wiring requires modifying src/app/bootstrap.ts beyond pass-through into ModelRouter — STOP with FAIL: scope.",
    "Flag-off path produces non-identical behavior on existing tests — STOP with FAIL: test.",
    "BIFROST_BASE_URL or BIFROST_API_KEY missing while BIFROST_ENABLED=true — log via logger.warn('bifrost', 'flag enabled but env missing — falling back to legacy router', { url: !!process.env.BIFROST_BASE_URL, key: !!process.env.BIFROST_API_KEY }) and proceed flag-off; do NOT throw, do NOT exit.",
    "Spec contradicts code (read_context line ranges no longer match actual file contents) — STOP with FAIL: precheck:spec-mismatch."
  ],
  "glossary": {
    "Constructor signature change": "ModelRouter constructor adds a second optional parameter `bifrost?: BifrostProvider`. Existing call sites (src/app/deps.ts) pass undefined unless BIFROST_ENABLED is set. This is additive — TypeScript-compatible with all existing callers.",
    "Flag-on routing": "When this.bifrost is defined AND process.env.BIFROST_ENABLED === 'true', ModelRouter.chat / chatStream short-circuit: resolve virtualModel via resolveModel() to get { model, provider } → call this.bifrost.chat({ ...params, model: resolved.model }) → return. No fallback to runChatDispatch on error (architectural decision #4); errors surface as ProviderError or UpstreamExhaustedError.",
    "Flag-off routing": "this.bifrost === undefined OR process.env.BIFROST_ENABLED !== 'true' — current runChatDispatch + createFallbackStream paths run unchanged, byte-identical to pre-merge.",
    "Bifrost limiter": "BifrostProvider calls do NOT go through any subbrain RateLimiter — Bifrost owns its own rate limiting. This is explicit because architectural decision #2 keeps BifrostProvider out of the backends map. (Trade-off accepted: if Bifrost is slower than expected, dispatch back-pressure happens at the HTTP layer, not the limiter queue.)"
  }
}
```

### Required shape (P1-4)

`src/providers/index.ts` adds (≤25 new LOC):

```ts
import { BifrostProvider } from "./bifrost";

export function createBifrostProvider(): BifrostProvider | undefined {
  if (process.env.BIFROST_ENABLED !== "true") return undefined;
  const url = process.env.BIFROST_BASE_URL;
  const key = process.env.BIFROST_API_KEY;
  if (!url || !key) return undefined; // logger.warn handled by caller
  return new BifrostProvider(url, key);
}
```

`src/lib/model-router.ts` adds (≤25 new LOC; current file is 121 lines, target
≤146 after edit):

```ts
import type { BifrostProvider } from "../providers/bifrost";
// inside class:
private bifrost?: BifrostProvider;

constructor(
  providers: Record<ProviderName, LLMProvider>,
  bifrost?: BifrostProvider,
) {
  // ... existing body ...
  this.bifrost = bifrost;
}

// in chat(), top of method, after resolveModel:
if (this.bifrost && process.env.BIFROST_ENABLED === "true") {
  return this.bifrost.chat({ ...params, model: primary.model, signal: params.signal });
}
// ... existing dispatch ...

// in chatStream(), analogous early branch returning Promise.resolve(this.bifrost.chatStream(...))
```

`src/app/deps.ts` change is one line: pass `createBifrostProvider()` as the
second arg to `new ModelRouter(...)`.

---

## Packet P1-5 — fallback / cancel / auth-error tests

```json
{
  "task_id": "P1-5",
  "goal": "Add tests covering Bifrost-down behaviour, stream cancel propagation, and 401/403/429/5xx mapping; no production code edits.",
  "non_goals": [
    "Do not edit any file under src/.",
    "Do not run live network calls — all upstreams must be mocked via Bun.serve test fixtures.",
    "Do not introduce new test frameworks — bun:test only.",
    "Do not modify existing tests/model-router.test.ts beyond imports needed.",
    "Do not change MODEL_MAP, rate-limiter, or direct-mode behavior.",
    "Do not add tests touching embed/rerank — those stay on raw NVIDIA.",
    "Do not assert that Bifrost-down falls through to legacy runChatDispatch — architectural decision #4 says it does NOT."
  ],
  "allowed_write_paths": [
    "tests/bifrost-fallback.test.ts",
    "tests/bifrost-cancel.test.ts",
    "tests/bifrost-auth-errors.test.ts"
  ],
  "read_context": [
    "src/providers/bifrost.ts",
    "src/lib/model-router.ts",
    "src/providers/nvidia.ts:1-100",
    "src/providers/nvidia.ts:155-165",
    "tests/model-router.test.ts",
    "src/lib/errors.ts"
  ],
  "risk_tier": "ordinary",
  "acceptance": [
    "bunx tsc --noEmit",
    "bun test tests/bifrost-fallback.test.ts tests/bifrost-cancel.test.ts tests/bifrost-auth-errors.test.ts",
    "wc -l tests/bifrost-fallback.test.ts | awk '{ exit ($1 <= 150) ? 0 : 1 }'",
    "wc -l tests/bifrost-cancel.test.ts | awk '{ exit ($1 <= 150) ? 0 : 1 }'",
    "wc -l tests/bifrost-auth-errors.test.ts | awk '{ exit ($1 <= 150) ? 0 : 1 }'",
    "bun run scripts/check-file-size.ts",
    "bun run scripts/check-deep-imports.ts"
  ],
  "diff_budget_loc": 280,
  "file_count_max": 3,
  "rollback": "git rm tests/bifrost-fallback.test.ts tests/bifrost-cancel.test.ts tests/bifrost-auth-errors.test.ts",
  "escalation_triggers": [
    "Test requires modifying src/ to inject a mock — STOP with FAIL: scope.",
    "Mock Bun.serve cannot accept POST + SSE — STOP with FAIL: precheck.",
    "Test cannot deterministically verify cancel propagation (flake > 1/100) — STOP with FAIL: test.",
    "Spec contradicts code (e.g. ProviderError signature differs from src/providers/nvidia.ts:155-165) — STOP with FAIL: precheck:spec-mismatch."
  ],
  "glossary": {
    "Fallback test": "BIFROST_ENABLED=true, BifrostProvider returns ECONNREFUSED → ModelRouter.chat MUST surface UpstreamExhaustedError (or wrapped fetch error). It MUST NOT call runChatDispatch as a second-level fallback (assert dispatch.ts not invoked — easiest: spy on backends.nvidia.provider.chat, assert callCount === 0).",
    "Cancel test": "Caller-side AbortController.abort() during streaming → BifrostProvider.chatStream reader gets DOMException('Aborted', 'AbortError'); no further bytes enqueued; no DB writes downstream (assert via spy on chatRepo.append).",
    "Auth-error mapping": "401 → ProviderError(401, body), 403 → ProviderError(403, body), 429 → ProviderError(429, body), 5xx → ProviderError(5xx, body). The flag-on path does NOT invoke RateLimiter.backoff429() because BifrostProvider does not go through a subbrain limiter (architectural decision #2)."
  }
}
```

---

## Packet P1-6 — populate Bifrost providers map (4 providers) + parity test

```json
{
  "task_id": "P1-6",
  "goal": "Replace the empty providers map in bifrost/config.json with NVIDIA, MiniMax, OpenRouter, and openai-compat (cliproxy) entries; add a parity test asserting all four providers in MODEL_MAP are reachable through the Bifrost config.",
  "non_goals": [
    "Do not run this packet until P1-1..P1-5 are merged green.",
    "Do not remove cliproxy from docker-compose.yml — openai-compat in Bifrost POINTS AT cliproxy, not replaces it.",
    "Do not change MODEL_MAP role assignments.",
    "Do not modify src/providers/bifrost.ts (config-only change).",
    "Do not change rate-limiter or direct-mode behavior.",
    "Do not break BIFROST_ENABLED=false default.",
    "Do not commit any real API key value into config.json — use the env.VAR_NAME literal string syntax.",
    "Do not invent a base_url/provider_type field if the upstream Bifrost schema does not document one — escalate instead."
  ],
  "allowed_write_paths": [
    "bifrost/config.json",
    "tests/bifrost-config-parity.test.ts"
  ],
  "read_context": [
    "bifrost/config.json",
    "src/lib/model-map.ts:1-30",
    "src/providers/index.ts:35-42",
    "docker-compose.yml:1-20"
  ],
  "risk_tier": "public-api",
  "acceptance": [
    "bun -e 'const c = await Bun.file(\"bifrost/config.json\").json(); for (const p of [\"openai\", \"minimax\", \"openrouter\", \"openai-compat\"]) { if (!c.providers[p]) throw new Error(\"missing provider \"+p); }'",
    "bun test tests/bifrost-config-parity.test.ts",
    "bunx tsc --noEmit",
    "docker compose -f docker-compose.yml config --quiet",
    "wc -l bifrost/config.json | awk '{ exit ($1 <= 80) ? 0 : 1 }'",
    "wc -l tests/bifrost-config-parity.test.ts | awk '{ exit ($1 <= 100) ? 0 : 1 }'",
    "bun run scripts/check-file-size.ts",
    "bun run scripts/check-deep-imports.ts"
  ],
  "diff_budget_loc": 120,
  "file_count_max": 2,
  "rollback": "git checkout HEAD -- bifrost/config.json && git rm tests/bifrost-config-parity.test.ts",
  "escalation_triggers": [
    "Bifrost config schema does not document a base_url override on the openai provider type (needed for NVIDIA NIM + cliproxy) — STOP with FAIL: upstream-docs:custom-base-url-shape. Parent must research the upstream schema (https://www.getbifrost.ai/schema), document the correct shape in operator-pre-fill, then re-dispatch P1-6.",
    "Parity test requires src/ modification — STOP with FAIL: scope.",
    "P1-1..P1-5 not merged or not green — STOP with FAIL: precheck.",
    "Spec contradicts code (e.g. ProviderName union has changed since P1-1, or cliproxy port in docker-compose.yml is no longer 8317) — STOP with FAIL: precheck:spec-mismatch.",
    "OpenRouter or MiniMax env keys absent from .env.example after P1-1..P1-5 merges — STOP with FAIL: precheck:env-missing."
  ],
  "glossary": {
    "Parity test": "Static assertion: every ProviderName from src/lib/model-map.ts:6 ('nvidia'/'openrouter'/'minimax'/'openai-compat') appears as a key under bifrost/config.json::providers. Mapping note: subbrain ProviderName 'nvidia' maps to Bifrost provider key 'openai' (with NVIDIA NIM base_url) because Bifrost groups OpenAI-protocol providers under the 'openai' type. Test must encode this mapping explicitly: const PARITY_MAP = { nvidia: 'openai', openrouter: 'openrouter', minimax: 'minimax', 'openai-compat': 'openai-compat' }.",
    "openai-compat in Bifrost": "Provider entry pointing to the same cliproxy URL as src/providers/index.ts:127 default (http://cliproxy:8317/v1 — port 8317 per docker-compose.yml:9, NOT 8080). Bifrost is the gateway; cliproxy is the upstream — no loop.",
    "env.VAR_NAME literal": "Bifrost config syntax for env-var-from-runtime: e.g. 'value': 'env.NVIDIA_API_KEY'. Confirmed from upstream quickstart. NEVER inline a real API key."
  }
}
```

---

## Output contract (every packet)

Success:

```text
OK <task_id>: <one-line summary>
```

Failure (no speculative redesign):

```text
FAIL: <category>: <short reason>
```

Categories: `precheck`, `scope`, `typecheck`, `test`, `upstream-docs`, `unknown`.

`precheck:spec-mismatch` is a sub-category for "spec contradicts code" — required by
weak-spec-writer pre-flight checklist.

## Parent review checklist (after each packet)

1. `git diff <branch>` matches packet `allowed_write_paths` exactly — no
   collateral edits.
2. LOC delta ≤ packet budget; per-file `wc -l` ≤ 150 (acceptance enforces).
3. All acceptance commands run green locally.
4. `BIFROST_ENABLED=false` smoke: existing chat/stream + direct-mode behavior
   byte-identical to pre-merge baseline (run `bun test tests/chat-direct-mode.test.ts`).
5. CLAUDE.md guardrails spot-check: `Promise.allSettled`, `AbortSignal`
   threading, `fetchJson`/`fetchStream` only, no raw `fetch`, logger 3-arg,
   `redactSecrets` on error bodies via `ProviderError`, file ≤150 LOC, no
   deep-imports.
6. No new entries in `MODEL_MAP`, no DB migration, no roles UI, no `bifrost` in
   `ProviderName` union.
7. Architectural decisions #1–6 (top of doc) all preserved by the diff.
