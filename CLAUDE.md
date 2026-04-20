# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Authoritative architecture docs

- `README.md` — quickstart, env vars, Continue config, deploy.
- `AGENTS.md` — full architecture, virtual roles → real models map, memory layers, request pipeline, night cycle.
- `docs/01-…` … `docs/14-…` — per-subsystem specs (server, db schema, model router, RAG, MCP tools, agent pipeline, auth, observability, arbitration, night cycle, code-tools roadmap, agent workspace, dev machine, chaos advisor, **active audit + fix log**).

When making non-trivial changes, read the matching `docs/NN-…` first; if you change behavior described there, update the doc in the same change.

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

- **Prod VPS:** `ssh root@109.120.187.244`. Caddy reverse-proxy terminates HTTPS and proxies to the Bun container on `:4000`. The SQLite volume lives inside the container — `docker compose down -v` on this box wipes real memory, not just dev data.
- **Autodeploy is currently OFF** — GitHub blocked the account, so the `gh`-driven push-to-deploy path doesn't run. Until that's unblocked, deploy by SSH-ing in, `git pull` (or `scp`/`rsync` the diff), `docker compose build && docker compose up -d`. Keep this in mind: a merged PR does NOT reach prod on its own right now.

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

### MCP tools: single registry, three transports

Every tool is declared **once** in `src/mcp/registry/` and reused across REST (`transport.ts`), MCP JSON-RPC (`mcp-protocol.ts`), and the autonomous agent loop. Adding a tool means: `registry.register({ name, description, scope, input: t.Object({...}), handler })`. No parallel switch-cases to keep in sync — forget the entry and TS refuses to compile.

- **Domain logic** still lives in `src/mcp/tools/` (`MemoryTools`, `EmbedTools`, `LogTools`, `WebTools`) and `src/mcp/telegram-tools.ts`; `ToolExecutor` wires them up. Registry handlers delegate here, so `bun test tests/mcp-tools.test.ts` stays meaningful.
- **Schemas** are TypeBox (`t.Object`) — same validator as HTTP routes, and serialized straight to JSON Schema for OpenAI tool-calling, so there is no separate `tool-defs.ts` anymore.
- **Scopes** split public from agent-only: `scope: "public"` is exposed via REST/MCP; `scope: "agent-only"` (think, done, consult_*, create_tool, *_code_tool) is only handed to the autonomous loop.
- **Context** is `{ executor, router?, room?, dynamicTools?, codeTools?, log?, registry? }`. Public callers pass `{ executor }`; the agent loop populates the rest. Agent-only handlers must guard against missing optional fields.
- `src/pipeline/agent-loop/tool-runner.ts` is now a thin dispatcher: registry first, then fallback to dynamic tools (runtime-created via `create_tool`) and sandboxed code tools (`code_*` prefix). `done` is special-cased — its `data` string is returned raw because `agent-loop/index.ts` treats it as a control signal.
- Web tools wrap an out-of-process Playwright MCP client (`src/mcp/playwright-client.ts`); browser sessions persist across calls.

### Pipelines fan out and need careful error semantics

`src/pipeline/arbitration-room.ts` runs N specialists in parallel and feeds their answers to the team-lead for synthesis. `src/pipeline/agent-loop/index.ts` runs a tool-calling loop with a wall-clock budget (~25s) and a step cap (default 8, env `AUTONOMOUS_MAX_STEPS`). Pre/post-processing in `src/pipeline/agent-pipeline/` shares state with main execution via the request id; **don't reuse request ids across chats** — Layer 4 partitioning depends on it.

### Logger contract

`src/lib/logger.ts` exports `info/warn/error/debug` with the signature `(stage: string, message: string, extra?)` — passing only one argument silently puts the whole text into `stage`, leaving `message` undefined and writing garbage to Layer 4. Always use `logger.info("subsystem", "...")`.

## Conventions specific to this repo

- **Bun-only runtime.** Use `Bun.file`, `Bun.write`, `bun:sqlite`, `bun:test`. Don't reach for `node:fs` unless you have a reason.
- **Elysia for HTTP.** Body validation uses Elysia's `t.Object`/`t.Literal` (TypeBox), not Zod — keep new routes consistent with `src/routes/chat.ts`.
- **No TS errors are tolerated** — `bunx tsc --noEmit` must stay at exit 0. The repo just got typecheck-clean (round 1 of `docs/14-audit-2026-04-20.md`).
- **Tests are `bun:test`** with `describe/test/expect`. Older script-style tests with top-level code + `process.exit()` get picked up by `bun test` and kill the whole runner — never reintroduce that pattern. Live tests go in `*.live.ts` so `bun test` ignores them.
- **`.env` is required** for the server to start (auth token + provider keys). Tests that need a DB use `data/test.db` and clean it themselves; never point them at `data/subbrain.db`.

## Active refactor

`docs/14-audit-2026-04-20.md` is the running log of an in-progress audit/refactor. CRIT-1…CRIT-7 are closed; HIGH-1…HIGH-10 and MEDIUM items are pending. Before making large changes in `routes/`, `providers/`, `pipeline/`, `db/`, `rag/`, or `mcp/`, check whether your area is on the open list and either coordinate or knock the item off and update the doc.
