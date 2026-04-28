# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Authoritative architecture docs

- `README.md` — quickstart, env vars, Continue config, deploy.
- `AGENTS.md` — full architecture, virtual roles → real models map, memory layers, request pipeline, night cycle.
- `docs/completed/` — спецификации реализованных подсистем (server, db schema, model router, RAG, MCP tools, agent pipeline, auth, observability, arbitration, night cycle, code tools, chaos advisor).
- `docs/01-refactor-plan.md`, `docs/02-audit.md` — открытый план рефакторинга и журнал аудита.
- `docs/03-agent-workspace.md`, `docs/04-dev-machine.md` — открытые roadmap-доки про докер-контейнер агента.
- `docs/tasks/` — разбитые на файлы активные продуктовые таски (RAG для отчётов, TG polling, freelance scout, web UI fixes).
- `docs/tasks/refactor/` — 15 таск-файлов под мастер-план рефакторинга (по PR на файл, см. `docs/tasks/refactor/README.md`).

When making non-trivial changes, read the matching doc first; if you change behavior described there, update the doc in the same change. Если задача одна из `docs/tasks/*` или `docs/tasks/refactor/*` — работать внутри соответствующего файла, синхронизировать со статусом.

## Coding guardrails (from refactor PR 01-15)

Before editing `src/`, `web/app/`, `scripts/`, `tests/` — invoke the `subbrain-guardrails` skill (`.claude/skills/subbrain-guardrails/SKILL.md`). It encodes the lessons of the 15-PR refactor; violating it re-opens closed audit items. Hard rules (see skill for detail + red-flags table):

1. **File cap 150 lines** (lowered from 250 in 2026-04). Counts ALL lines (blank+comments+code). Vue SFC: 150 total = `<template>+<script>+<style>` вместе. Whitelist с per-file caps живёт в `scripts/check-file-size.ts` (single source); зеркалится в `subbrain-guardrails/SKILL.md` § "1. File size + split" — изменения только через PR с обоснованием. Orchestrator (`index.ts` разбитой папки) ≤100 строк, только композиция. Каждая разбитая папка имеет ровно одну публичную точку входа `index.ts`; multi-entry только с обоснованием (MCP registry per-domain `*.tools.ts`). Deep-imports (≥3 path segment'а после `..` И target имеет parent `index.ts`) запрещены, за исключением `import type`. 160-line связный файл → запрос whitelist через PR, не split насильно. Pre-existing oversize legacy (`db/tables/memory.ts`, `db/tables/shared.ts`, `repositories/memory.repo.ts`, `services/memory.service.ts`, `mcp/tools/memory-tools.ts`, `pipeline/arbitration-room.ts`, `mcp/executor.ts`, `playwright-client.ts`, `telegram/bot.ts`, `telegram/userbot.ts`, `services/chat.service.ts`, `rag/pipeline.ts`) — split по wave-плану [docs/tasks/refactor/28-file-size-150-limit.md](docs/tasks/refactor/28-file-size-150-limit.md), не grow в новых PR.
1a. **Three-layer SoC + cross-layer rules.** Data (`src/db/tables/*`, `src/repositories/*`) — только raw SQL + row→entity mapping; никаких HTTP/pipeline/RAG-вызовов. Logic (`src/services/*`, `src/pipeline/*`, `src/mcp/tools/*`, `src/scheduler/*`) — только бизнес-правила; SQL только через repository API; никакого Elysia-контекста. View / transport (`src/routes/*`, `src/mcp/transport.ts`, `src/mcp/mcp-protocol.ts`, `web/app/pages/**`, `web/app/components/**`) — валидация входа + delegation в logic + форматирование ответа; никакого SQL, никакой бизнес-логики. Cross-layer: Logic→Data только через repo; View→Logic только через service. View→Data напрямую запрещено. Logic→View запрещено — scheduler/pipeline отправляют уведомления через `src/telegram/bot/notify(chatId,msg)` (logic-helper, не transport). Data→Logic / Data→View запрещено абсолютно. **Routes** must not contain `SELECT|INSERT INTO|UPDATE … SET|DELETE FROM`. **Pages/components** must not contain `$fetch`/raw `fetch(`/`useApi(` вне composable-обёртки. Composables: single responsibility (data | UI-state | transform); смешивание → split.
2. **`Promise.allSettled`**, never `Promise.all`, for fan-out upstream calls. `AbortController` composed with external signal, threaded through `ModelRouter.chat` → providers; providers check `signal.aborted` before start + in stream callback.
3. **Per-tool timeout** in `tool-runner.ts` via `Promise.race`; scopes `web_*`=15s, `memory_*`=3s, `embed_*`=5s, `consult_*`=20s, default=5s. Timeout → `ToolError{code:"timeout"}`, not throw.
4. **Rate-limit** atomic `tryAcquire()` under `Mutex`. **Fallback** capped `MAX_FALLBACK_ATTEMPTS=1` → `UpstreamExhaustedError` → 502.
5. **SSE:** `: ping\n\n` every 5s, `idleTimeout:255`. `wrapStreamForChat` honors `isClosed` — no DB writes after cancel. SSE chunk parsing = `providers/sse-parser.ts` (no reimplementation).
6. **DB:** insert + embed/index wrapped in `db.transaction()`. Batch lookups `WHERE id IN (?,?,…)`. FTS input → `sanitizeFtsQuery`. Migrations in `db.transaction()` + per-statement `.run()`. Mutations via `updateRow(table, ALLOW, id, patch)`.
7. **HTTP:** all outbound `fetch` via `src/lib/http-client.ts` (`fetchJson`/`fetchStream`). Default 60s, MiniMax streams 180s. No raw `fetch` in new code.
8. **Validation:** Elysia TypeBox for every route input; `role` via `t.Union([t.Literal(...)])`. Inbound → `normalizeMessages()`. No `(x as any)` / `ctx.router!` — `AgentContext` discriminated union. `ToolResult = {ok:true,data}|{ok:false,error:{code,message}}`.
9. **Logger:** `logger.info(stage, message, extra?)` — single-arg call is a bug. Top of module: `const log = logger.child("minimax")`. Meta → `logger.formatForDb`.
10. **Errors + envelopes:** central `onError` + domain errors (`AppError`, `UpstreamExhaustedError`, `ToolError`, `HttpError`). `{ items, total }` via `lib/api-envelope.ts` (`PaginatedResponse<T>` + `paginate()`). Echoed upstream bodies sliced ≤200 chars + regex-redact secrets.
11. **Single sources of truth:** virtual roles / embed / rerank — only `lib/model-map.ts`. MCP tools — only `mcp/registry/*.tools.ts` + `mcp/tools/*` domain logic. Tool dispatcher = priority array of resolvers.
12. **Tests:** `bun:test` with `describe/test/expect`. No top-level `process.exit`. Live tests = `*.live.ts`. Test DB = `data/test.db`.
13. **Security:** `timingSafeEqual` + SHA-256 for token compare. Destructive scripts require `--confirm` or non-prod path. Logs mask `api_key|authorization|token|bearer` by default. Sandbox throws `sandbox_unavailable` when `Worker` missing.
14. **Docs sync:** split/move a file → update CLAUDE.md paths + matching `docs/completed/*.md` in the same PR. Close task: ✅ `docs/02-audit.md`, strike in `docs/01-refactor-plan.md`, `Status: DONE (PR #N)` in task file.
15. **Code-tools no hardcoded facts** (F-2/F-3b/F-4, см. `docs/tasks/code-tools-poisoning-fix.md`). Background: 27.04.2026 free-agent fake-digest incident, диагноз `~/vault/RLM/Daily/2026-04-28.md`.
    - `create_code_tool`/`edit_code_tool` reject body с ≥2 hardcoded-fact patterns (имена клиентов / `chat_id` literals / `overdue_hours` / DD.MM dates / urgency emoji + key). Validator: `src/pipeline/agent-loop/code-tools/code-tool-validators.ts`.
    - 4 known stateful client tools (`overdue_reminder`/`silent_projects_check`/`critical_clients_monitor`/`client_followup_check`) hidden от `agentMode==="scheduled"` через `STATEFUL_CLIENT_CODE_TOOLS` Set в `scheduled-blacklist.ts`. Расширять список при появлении новых stateful tools.
    - `tg_send_message` blocks scheduled runs пока `layer1_focus.no_repetitive_tg_spam` non-empty AND set ≤7d ago (`telegram-spam-gate.ts`). Interactive runs bypass — у юзера прямой контроль. Override scheduled = `deleteFocus("no_repetitive_tg_spam")`.
    - **Никогда** не embed dynamic facts (status, deadlines, names, chat_ids) как const'ы в code-tool body — pass через `input` или query memory/tg_read_chat в runtime.

## Common commands

```bash
bun install
bun run src/index.ts                   # start proxy on :4000 (requires .env)
bun run scripts/seed.ts                # populate Layer 1 + shared_memory
bun run scripts/audit-db.ts            # snapshot DB counts / health
bun run scripts/tg-login.ts            # one-time: obtain TG MTProto session

bun test                               # full bun:test suite (do not pass paths to run all)
bun test tests/rag.test.ts             # single file
bun test --test-name-pattern "FTS5"    # filter by test name
bunx tsc --noEmit                      # typecheck (no emit; tsbuildinfo is committed)

bun run tests/integration.live.ts      # live end-to-end against a RUNNING server on :4000
                                       # (file is *.live.ts on purpose so bun test does not pick it up)
```

Docker: `docker compose build && docker compose up -d`. **Never `docker compose down -v`** — that wipes the SQLite volume.

## Deploy

> ⚠️ **Deploys are 100% manual right now.** GitHub has blocked the account, so `gh` CLI and every push-to-deploy / PR-triggered path is dead. `git push` / merging a PR does NOT reach prod. Don't suggest `gh pr create`, `gh workflow run`, or any GitHub-automation flow until this is unblocked — it will just fail.

- **Prod VPS:** `ssh root@109.120.187.244`. Repo path: `/opt/subbrain` (NOT `/root/subbrain` — that path doesn't exist; creating it via rsync is a mistake). Caddy reverse-proxy terminates HTTPS and proxies to the Bun container on `:4000`. The SQLite volume lives inside the container — `docker compose down -v` on this box wipes real memory, not just dev data.
- **Manual deploy procedure** (the only working path):
  1. `ssh root@109.120.187.244 && cd /opt/subbrain`
  2. `git pull` — or, if `git` itself is blocked by GitHub auth, `rsync` changed files from workstation: `rsync -avz <files> root@109.120.187.244:/opt/subbrain/ --relative`. ⚠️ **NEVER use `--delete`** (or any `--delete-*` variant). On prod live secrets NOT in git: `cliproxy/config.yaml`, `cliproxy/auths/` (Codex OAuth tokens, written by `--codex-device-login`), `.env*`. `--delete` wiped them on 2026-04-28 (twice in one session); recovery required interactive ChatGPT Pro re-login. If you need to remove stale prod files — `ssh root@... rm <path>` точечно.
  3. `docker compose build && docker compose up -d`
  4. `docker compose logs -f` to confirm boot.
- **Night cycle:** two schedulers, both idempotent (the HTTP endpoint and the in-process trigger share the same `nightCycleRunning` guard):
  - **In-process** (primary): fires daily at `NIGHT_CYCLE_HOUR_UTC` (default `3` = 03:00 UTC). On startup, checks `night_cycle_last_processed_id` vs. current log count; if backlog ≥ `NIGHT_CYCLE_BACKLOG_TRIGGER` (default 10 — aggressive: favour fresh compression over token savings), runs a catch-up 2 min after boot. Disable with `NIGHT_CYCLE_SCHEDULER=false`.
  - **System cron** (safety net): `scripts/install-cron.sh` installs `0 3 * * * curl .../night-cycle` on the VPS. Harmless duplicate — if in-process fires first, cron's request gets a `409 already_running`. Cron log: `/var/log/subbrain-night-cycle.log`.
  - **Manual trigger:** `ssh root@109.120.187.244 'curl -X POST http://127.0.0.1:4000/night-cycle'`. Status: `curl http://127.0.0.1:4000/night-cycle/status`.
  - **Post-processing extractor model:** `POST_EXTRACTOR_MODEL` env selects the virtual role used for agentic fact extraction after each chat/agent exchange (default `memory` — MiniMax-M2.7 via dedicated minimax provider since 2026-04-28; previously gpt-5.1 via cliproxy until ChatGPT Plus quota cooldown; previously `coder`/devstral-2; `flash` did not emit `tool_calls` in prod).
  - **Night-cycle step model:** `NIGHT_CYCLE_MODEL` env selects the role used for PII-scrub / translate / compress / verify / dedup inside the cycle (default `memory` — same MiniMax shape since 2026-04-28; previously gpt-5.1+MiniMax; previously `coder`; `flash`/stepfun was a reasoning model and spent ~25s/call on thinking, making a full cycle take 7+ hours).

## Architecture: things you can't see from one file

### Request flow has two modes, chosen at the route

`src/routes/chat.ts` decides between:

1. **Pipeline mode** (default for virtual roles): `AgentPipeline.execute()` runs `phases/pre.ts` (agentic hippocampus, builds executive summary from RAG + memory via `pre/exec-summary.ts`) → main specialist (`phases/main.ts`) → `phases/post.ts` (writes Layer 4 + agentic extraction). Streaming path goes through `phases/stream.ts`; arbitration-room synthesis through `phases/room.ts`. Used when `model in MODEL_MAP` and not direct.
2. **Direct mode**: routes straight through `ModelRouter` (no pre/post). Triggered by `X-Direct-Mode: true` header **or** automatically when `router.isOverloaded` (RPM saturated). This is a load-shedding mechanism, not a debugging flag.

Inbound messages from any route go through `normalizeMessages()` in `src/lib/messages.ts` to flatten OpenAI multipart `content: [{type:"text",text:…}]` into the strict `Message.content: string | null` providers expect. **Add new ingress points (e.g. autonomous, telegram) through this helper** — providers and the pipeline assume normalized content.

### Virtual roles, never real model IDs

`src/lib/model-map.ts` is the single source of truth: `teamlead`, `coder`, `critic`, `generalist`, `flash`, `chaos`, `memory` resolve to real model IDs + provider + fallback. `GET /v1/models` is generated from this map. **Never hardcode a model ID elsewhere** — change the map. `memory` (added 2026-04-25) is dedicated to hippocampus + night-cycle (MiniMax-M2.7 via dedicated minimax provider since 2026-04-28; was gpt-5.1 via cliproxy until Plus quota cooldown); `generalist` is the broad-purpose default for `dynamic_tools` (`create_tool`). Most LLM work goes to MiniMax (`minimax` provider, MiniMax-M2.7); NVIDIA NIM serves embed + rerank + most LLM fallbacks; OpenRouter is the resort fallback for unknown model IDs (e.g., `claude-*`, `gpt-*`, `gemini-*`).

**Optional OpenAI-compat bridge.** When `OPENAI_COMPAT_ENABLED=true`, `teamlead`/`coder` re-point to `gpt-5.4-mini` via a sidecar `cliproxy` container. Activation logic in `applyOpenAICompatOverrides` (called once at bootstrap before `createProviders`). Allowlist `gpt-5*/o3*/o4*/codex-*` only. See `docs/completed/03-model-router.md`.

### Memory: 4 layers, lazy load only on new chat

- `layer1_focus` (KV) and `shared_memory` are injected into **every** system prompt directly.
- `memory` table (layers 2–3) is loaded only at the start of a new chat via the RAG pipeline (`src/rag/pipeline.ts`) — hybrid FTS5 + sqlite-vec + NVIDIA rerank. Continuing an existing chat skips this.
- `raw_log` (Layer 4) is write-only from request handling and the night cycle; never injected into context.

Schema migrations live in `src/db/schema.ts` (`migrate()`); the `MemoryDB` constructor calls it on every open. FTS5 + `sqlite-vec` extensions are loaded there too. Always sanitize user-supplied FTS queries through `src/lib/fts-utils.ts:sanitizeFtsQuery` — raw input with `"`, `:`, `*` will throw at MATCH time.

### Provider rate-limiting and SSE proxying

`src/lib/rate-limiter.ts` per provider; `ModelRouter` schedules every call through it and exposes `isOverloaded` (used by routes to degrade to direct mode). Streaming responses go through `src/providers/stream-utils.ts:createProxyStream` (provider) → `src/lib/sse.ts:sseResponse` (HTTP) → optional `wrapStreamForChat` in `routes/chat.ts` (parses SSE chunks to persist the assembled assistant message into the `chats` table).

**SSE heartbeat:** The autonomous agent loop (and any long-running SSE stream) sends `: ping\n\n` every 5 seconds via `setInterval`. Without this, Caddy's HTTP/2 proxy kills idle streams with `ERR_HTTP2_PROTOCOL_ERROR`. The server also sets `idleTimeout: 255` in `.listen()` to prevent Bun's own idle-socket GC from firing mid-stream.

### MCP tools: single registry, three transports

Every tool is declared **once** in `src/mcp/registry/` and reused across REST (`transport.ts`), MCP JSON-RPC (`mcp-protocol.ts`), and the autonomous agent loop. Adding a tool means: `registry.register({ name, description, scope, input: t.Object({...}), handler })`. No parallel switch-cases to keep in sync — forget the entry and TS refuses to compile.

- **Domain logic** still lives in `src/mcp/tools/` (`MemoryTools`, `EmbedTools`, `LogTools`, `WebTools`) and `src/mcp/telegram-tools.ts`; `ToolExecutor` wires them up. Registry handlers delegate here, so `bun test tests/mcp-tools.test.ts` stays meaningful.
- **Schemas** are TypeBox (`t.Object`) — same validator as HTTP routes, and serialized straight to JSON Schema for OpenAI tool-calling, so there is no separate `tool-defs.ts` anymore.
- **Scopes** split public from agent-only: `scope: "public"` is exposed via REST/MCP; `scope: "agent-only"` (think, done, consult_*, create_tool, *_code_tool) is only handed to the autonomous loop.
- **Context** is `{ executor, router?, room?, dynamicTools?, codeTools?, log?, registry? }`. Public callers pass `{ executor }`; the agent loop populates the rest. Agent-only handlers must guard against missing optional fields.
- `src/pipeline/agent-loop/tool-runner.ts` is now a thin dispatcher: registry first, then fallback to dynamic tools (runtime-created via `create_tool`) and sandboxed code tools (`code_*` prefix). `done` is special-cased — its `data` string is returned raw because `agent-loop/index.ts` treats it as a control signal.
- Web tools use a direct in-process Playwright wrapper in `src/mcp/playwright-client.ts` (public API `callTool(name, args)` unchanged). Browser channel is `chrome` (installed in Dockerfile), launched headless + `--no-sandbox`. Snapshot tags interactive elements with `data-pw-ref="N"` attributes; click/type select by that attr. Refs reset every snapshot.

### Agentic post-processing (hippocampus)

After **every** chat exchange (user message + assistant reply), `src/pipeline/agent-pipeline/post/hippocampus.ts` (orchestrated by `phases/post.ts:runPost`) runs a small agent loop (`model = POST_EXTRACTOR_MODEL`, default `memory` since 2026-04-25 = gpt-5.1+MiniMax) with three tools: `memory_search`, `memory_write`, `done`. Cap: `MAX_HIPPO_STEPS = 5`. Gate: `post/gate.ts:shouldRunHippocampus` skips if `userMessage.length + assistantText.length < MIN_EXTRACTION_LENGTH` (=100). Writers live in `post/extractors.ts` (`writeShared`/`writeContext`).

- `memory_write layer:"shared"` → `memory.insertShared()` (global facts)
- `memory_write layer:"context"` → `memory.insertContext()` + `rag.indexEntry()` (per-session context, FTS-indexed)
- `done` → terminates the loop

**Do not use `flash` (stepfun) for this** — it is a reasoning model and returns its answer in `content`, not `tool_calls`, so tool-calling doesn't work.

### Context compressor

`src/pipeline/context-compressor.ts` triggers when the raw message array exceeds `SOFT_LIMIT = 80_000` chars (rough token estimate × 4). Strategy: keep head (all system messages + first user turn) and tail (last 10 messages, snapped to avoid orphan tool messages), collapse the middle via a `flash` summary call. Summary JSON `{ summary, facts[] }` is inserted back as a single assistant message; `facts[]` are written to `shared_memory` via `memory.insertShared()`. Mutates `messages` in-place, returns `false` on any failure so the pipeline falls back to unclamped context. Called in both `AgentLoop.run()` and `AgentLoop.createStream()`.

### Memory admin HTTP surface

`src/routes/memory.ts` exposes the same memory layers to the web UI (`/memory` page) that agents reach via MCP `memory_*` tools. All endpoints are behind `authMiddleware` and return `{ items, total }` envelopes for paginated lists. Paths: `/v1/memory/focus`, `/v1/memory/shared`, `/v1/memory/context`, `/v1/memory/archive`, `/v1/memory/agent`, `/v1/memory/log` (read-only). `?q=` on list endpoints delegates to the FTS5 helpers on `MemoryDB` (which internally call `sanitizeFtsQuery`); FTS hits are **rehydrated** to full rows via `getShared/getContext/getArchive(hit.id)` before returning — FtsResult (sparse) is never sent to the UI. On each `PATCH`/`DELETE` the route checks the row exists first and returns a 404 shaped like `{ error: { message } }` — same as `chats.ts`.

**Frontend:** `web/app/pages/memory.vue` (6-tab admin page), `web/app/composables/useMemory.ts` (per-layer `useState` with pagination/search/mutations), `web/app/components/MemoryRow.vue` (compact list row). Linked from the chat sidebar via "🧠 Память" `NuxtLink`. All mutations use `useApi()`'s `api()` helper which injects the Bearer token.

### Pipelines fan out and need careful error semantics

`src/pipeline/arbitration-room.ts` runs N specialists in parallel and feeds their answers to the team-lead for synthesis. `src/pipeline/agent-loop/index.ts` is now a thin facade: orchestration lives in `run.ts` (non-stream) and `stream.ts` (SSE), per-step logic in `step.ts`, tool-call normalization/dispatch in `tool-dispatch.ts`, heartbeat in `heartbeat.ts`, compression hook in `compressor-hook.ts`, chat/tools persistence in `persist.ts`. Step cap `MAX_STEPS = 100` (hard ceiling in `agent-loop/types.ts`). The autonomous scheduler defaults to 100 steps too, overridable via env `AUTONOMOUS_MAX_STEPS` (clamped 1..100). The web frontend's interactive agent mode passes its own `max_steps` per request (currently 12). Pre/post phases in `src/pipeline/agent-pipeline/phases/` share state with main execution via the request id; **don't reuse request ids across chats** — Layer 4 partitioning depends on it.

### Logger contract

`src/lib/logger.ts` exports `info/warn/error/debug` with the signature `(stage: string, message: string, extra?)` — passing only one argument silently puts the whole text into `stage`, leaving `message` undefined and writing garbage to Layer 4. Always use `logger.info("subsystem", "...")`.

### Free agent (curious autonomous loop)

`src/scheduler/free-agent.ts` — second autonomous scheduler running in parallel with `AUTONOMOUS`. Uses the same `AgentLoop.run({model:"teamlead", priority:"low"})` but with an open-ended "curiosity" task prompt (`FREE_AGENT_TASK` env override, default in the module). On finish, `result.finalAnswer` is sent as a TG digest via `telegramBot.notify` (`🤖 Free agent — <stoppedReason> (<steps>)`).

Off by default (`FREE_AGENT=false`). Knobs: `FREE_AGENT_INTERVAL_MIN` (default 60), `FREE_AGENT_MAX_STEPS` (default 50), `FREE_AGENT_STARTUP_DELAY_MS` (default 60_000). Shares the main Playwright browser — no context isolation. Re-entry guard: same-instance runs cannot overlap.

Safety rules are baked into the default prompt: no payments/irreversible actions, no leaking `PROXY_AUTH_TOKEN` / cookies, suggest-before-act for SMS/email/outbound calls. The agent can write new `code_tools` via `create_code_tool` and save findings via `memory_write`. All findings flow back via the TG digest.

### Freelance scout (parallel freelance-exchange scraper)

`src/scheduler/freelance/` — scout polls fl.ru / kwork.ru / freelance.ru in an **isolated Playwright context** (`PlaywrightClient.getScopePage("freelance")`, incognito + real-Chrome UA) so it doesn't pollute the main browsing session. Split upfront into `index.ts` (class ≤100 lines), `fetch.ts`, `evaluate.ts` (flash → coder fallback; JSON-parse result), `persist.ts` (writes `freelance_leads` row inside `db.transaction()` + TG alert via `TelegramBot.notify`), `types.ts`, `parsers/{fl,kwork,freelance,shared}.ts`. Fan-out across sources via `Promise.allSettled`. LLM eval wrapped in `AbortSignal.any([AbortSignal.timeout(10s), scout.abort.signal])`. 429 / anti-bot markers → `pausedUntil[domain] = now + 6h` + TG warn.

Admin surface: `src/routes/freelance.ts` (under `authMiddleware`, envelope via `paginate`) — `POST /v1/search/freelance/start|stop`, `GET /status`, `GET /leads?status=`, `PATCH /leads/:id`. UI: `web/app/pages/freelance.vue` + `web/app/composables/useFreelance.ts`.

Off by default (`FREELANCE_SCOUT=false`). Env: `FREELANCE_POLL_MIN`, `FREELANCE_CATEGORIES`, `FREELANCE_MIN_BUDGET`, `FREELANCE_MAX_BUDGET`, `FREELANCE_THRESHOLD`, `FREELANCE_TG_CHAT_ID`. Lifecycle: `installFreelanceScoutScheduler` in `app/schedulers.ts`; shutdown awaits `scout.stop()` (closes the `freelance` Playwright context) before the global `playwright.close()`.

**Legal note:** ToS of exchanges forbid automated scraping. Scout runs incognito (no user login), but risk of IP ban is non-zero. Flag off by default; manual `POST /start` required. Parser tests use synthetic fixtures (`tests/fixtures/freelance/*`); real a11y snapshots to be captured from prod headful on first tick.

## Conventions specific to this repo

- **Bun-only runtime.** Use `Bun.file`, `Bun.write`, `bun:sqlite`, `bun:test`. Don't reach for `node:fs` unless you have a reason.
- **Elysia for HTTP.** Body validation uses Elysia's `t.Object`/`t.Literal` (TypeBox), not Zod — keep new routes consistent with `src/routes/chat.ts`.
- **No TS errors are tolerated** — `bunx tsc --noEmit` must stay at exit 0. The repo just got typecheck-clean (round 1 of `docs/02-audit.md`).
- **Tests are `bun:test`** with `describe/test/expect`. Older script-style tests with top-level code + `process.exit()` get picked up by `bun test` and kill the whole runner — never reintroduce that pattern. Live tests go in `*.live.ts` so `bun test` ignores them.
- **`.env` is required** for the server to start (auth token + provider keys). Tests that need a DB use `data/test.db` and clean it themselves; never point them at `data/subbrain.db`.
- **Repository layer (PR 27).** Raw SQL lives only in `src/db/tables/*` and `src/repositories/*`. Services consume repos (`MemoryRepository`, `ChatRepository`, `LogRepository`, `TelegramRepository`, `FreelanceRepository`); `MemoryDB` is a thin facade kept for back-compat with `scripts/` + legacy tests. `tests/layer-boundary.test.ts` greps for leaks in `src/services/`, `src/routes/`, `src/pipeline/`.

## Active refactor

`docs/02-audit.md` is the running log of an in-progress audit/refactor. CRIT-1…CRIT-7 are closed; HIGH-1…HIGH-10 and MEDIUM items are pending. Before making large changes in `routes/`, `providers/`, `pipeline/`, `db/`, `rag/`, or `mcp/`, check whether your area is on the open list and either coordinate or knock the item off and update the doc.
