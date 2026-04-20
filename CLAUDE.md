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

- **Prod VPS:** `ssh root@109.120.187.244`. Caddy reverse-proxy terminates HTTPS and proxies to the Bun container on `:4000`. The SQLite volume lives inside the container — `docker compose down -v` on this box wipes real memory, not just dev data.
- **Manual deploy procedure** (the only working path):
  1. `ssh root@109.120.187.244`
  2. `cd` into the repo and `git pull` — or, if `git` itself is blocked by GitHub auth, `scp` / `rsync` the changed files from your workstation.
  3. `docker compose build && docker compose up -d`
  4. `docker compose logs -f` to confirm boot.
- **Night cycle:** two schedulers, both idempotent (the HTTP endpoint and the in-process trigger share the same `nightCycleRunning` guard):
  - **In-process** (primary): fires daily at `NIGHT_CYCLE_HOUR_UTC` (default `3` = 03:00 UTC). On startup, checks `night_cycle_last_processed_id` vs. current log count; if backlog ≥ `NIGHT_CYCLE_BACKLOG_TRIGGER` (default 100), runs a catch-up 2 min after boot. Disable with `NIGHT_CYCLE_SCHEDULER=false`.
  - **System cron** (safety net): `scripts/install-cron.sh` installs `0 3 * * * curl .../night-cycle` on the VPS. Harmless duplicate — if in-process fires first, cron's request gets a `409 already_running`. Cron log: `/var/log/subbrain-night-cycle.log`.
  - **Manual trigger:** `ssh root@109.120.187.244 'curl -X POST http://127.0.0.1:4000/night-cycle'`. Status: `curl http://127.0.0.1:4000/night-cycle/status`.
  - **Post-processing extractor model:** `POST_EXTRACTOR_MODEL` env selects the virtual role used for agentic fact extraction after each chat/agent exchange (default `coder` — devstral-2, reliable at tool-calling; `flash` did not emit `tool_calls` in prod).
  - **Night-cycle step model:** `NIGHT_CYCLE_MODEL` env selects the role used for PII-scrub / translate / compress / verify / dedup inside the cycle (default `coder`; `flash`/stepfun was a reasoning model and spent ~25s/call on thinking, making a full cycle take 7+ hours).

## Architecture: things you can't see from one file

### Request flow has two modes, chosen at the route

`src/routes/chat.ts` decides between:

1. **Pipeline mode** (default for virtual roles): `AgentPipeline.execute()` runs `pre-processing` (flash, agentic, builds executive summary from RAG + memory) → main specialist → `post-processing` (flash, writes Layer 4). Used when `model in MODEL_MAP` and not direct.
2. **Direct mode**: routes straight through `ModelRouter` (no pre/post). Triggered by `X-Direct-Mode: true` header **or** automatically when `router.isOverloaded` (RPM saturated). This is a load-shedding mechanism, not a debugging flag.

Inbound messages from any route go through `normalizeMessages()` in `src/lib/messages.ts` to flatten OpenAI multipart `content: [{type:"text",text:…}]` into the strict `Message.content: string | null` providers expect. **Add new ingress points (e.g. autonomous, telegram) through this helper** — providers and the pipeline assume normalized content.

### Virtual roles, never real model IDs

`src/lib/model-map.ts` is the single source of truth: `teamlead`, `coder`, `critic`, `generalist`, `flash`, `chaos` resolve to real model IDs + provider + fallback. `GET /v1/models` is generated from this map. **Never hardcode a model ID elsewhere** — change the map. Most LLM work goes to GitHub Copilot (`copilot` provider); NVIDIA NIM is only for embed + rerank; OpenRouter is the fallback overflow.

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

After **every** chat exchange (user message + assistant reply), `src/pipeline/agent-pipeline/post-processing.ts` runs a small agent loop (`model = POST_EXTRACTOR_MODEL`, default `coder`) with three tools: `memory_search`, `memory_write`, `done`. Cap: `MAX_HIPPO_STEPS = 5`. Gate: skipped if `userMessage.length + assistantText.length < 100` chars.

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

`src/pipeline/arbitration-room.ts` runs N specialists in parallel and feeds their answers to the team-lead for synthesis. `src/pipeline/agent-loop/index.ts` runs a tool-calling loop with a step cap of `MAX_STEPS = 100` (hard ceiling in `agent-loop/types.ts`). The autonomous scheduler defaults to 100 steps too, overridable via env `AUTONOMOUS_MAX_STEPS` (clamped 1..100). The web frontend's interactive agent mode passes its own `max_steps` per request (currently 12). Pre/post-processing in `src/pipeline/agent-pipeline/` shares state with main execution via the request id; **don't reuse request ids across chats** — Layer 4 partitioning depends on it.

### Logger contract

`src/lib/logger.ts` exports `info/warn/error/debug` with the signature `(stage: string, message: string, extra?)` — passing only one argument silently puts the whole text into `stage`, leaving `message` undefined and writing garbage to Layer 4. Always use `logger.info("subsystem", "...")`.

## Conventions specific to this repo

- **Bun-only runtime.** Use `Bun.file`, `Bun.write`, `bun:sqlite`, `bun:test`. Don't reach for `node:fs` unless you have a reason.
- **Elysia for HTTP.** Body validation uses Elysia's `t.Object`/`t.Literal` (TypeBox), not Zod — keep new routes consistent with `src/routes/chat.ts`.
- **No TS errors are tolerated** — `bunx tsc --noEmit` must stay at exit 0. The repo just got typecheck-clean (round 1 of `docs/02-audit.md`).
- **Tests are `bun:test`** with `describe/test/expect`. Older script-style tests with top-level code + `process.exit()` get picked up by `bun test` and kill the whole runner — never reintroduce that pattern. Live tests go in `*.live.ts` so `bun test` ignores them.
- **`.env` is required** for the server to start (auth token + provider keys). Tests that need a DB use `data/test.db` and clean it themselves; never point them at `data/subbrain.db`.

## Active refactor

`docs/02-audit.md` is the running log of an in-progress audit/refactor. CRIT-1…CRIT-7 are closed; HIGH-1…HIGH-10 and MEDIUM items are pending. Before making large changes in `routes/`, `providers/`, `pipeline/`, `db/`, `rag/`, or `mcp/`, check whether your area is on the open list and either coordinate or knock the item off and update the doc.
