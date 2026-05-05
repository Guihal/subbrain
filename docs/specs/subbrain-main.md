# Subbrain main plan — current state 2026-05-05

> Canonical рабочий документ. Его потом декомпозируем на маленькие
> task-contracts для agent-teams. Старые vision/audit/completed docs лежат в
> `docs/old/неактуальное/`.

## TL;DR

Subbrain уже не "черновой прокси". Это single-user backend-first agent
platform: OpenAI-compatible API, role-based model routing, memory, RAG, MCP
tools, Telegram ingest, night-cycle, optional Nuxt UI.

Главная стратегия на ближайший цикл: не переписывать core, а стабилизировать
стыки.

1. Вынести LLM gateway в Bifrost side-car.
2. Добить `agent_tasks`/pool engine как artifact-producing autonomy.
3. Довести Memory-v2 до temporal/graph-aware уровня.
4. Добавить structured output + prompt CI через BAML/Promptfoo.
5. Подключить normal observability.
6. После этого переписывать frontend как workspace shell.

Scope rule for this document: this is the main scope, not the decomposition.
It may name gaps, risks, dependencies, and future workstreams, but concrete
Kimi/agent-teams contracts are written only after this scope is stable.

## Actual Code State

### Runtime and API

- Runtime: Bun.
- HTTP: Elysia.
- Main API: `/v1/chat/completions`, `/v1/models`, memory/tasks/logs/telegram
  admin routes.
- OpenAI-compatible shape is the integration surface for Continue/VS Code and
  local clients.
- Docker compose currently runs:
  - `subbrain` on `127.0.0.1:4000`;
  - `web` on `127.0.0.1:3000`;
  - `cliproxy` optional OpenAI-compat bridge.
- `cliproxy` is present in `docker-compose.yml` today. Treat it as an optional
  ChatGPT/CLIProxyAPI experiment, not as the general LLM gateway and not as a
  replacement for Phase 1 Bifrost.

### Providers and models

Current code source of truth: `src/lib/model-map.ts`.

Virtual roles are still code-driven constants, not DB/UI-driven.

Current role intent:

| Role | Current primary in code | Current fallback in code |
|---|---|---|
| `teamlead` | NVIDIA NIM `z-ai/glm-5.1` | MiniMax `MiniMax-M2.7` |
| `coder` | NVIDIA NIM `deepseek-ai/deepseek-v4-flash` | NVIDIA `qwen/qwen3-coder-480b-a35b-instruct` |
| `critic` | NVIDIA NIM `z-ai/glm-5.1` | MiniMax `MiniMax-M2.7` |
| `flash` | NVIDIA NIM `meta/llama-4-maverick-17b-128e-instruct` | MiniMax `MiniMax-M2.7` |
| `chaos` | NVIDIA NIM `moonshotai/kimi-k2.6` | MiniMax `MiniMax-M2.7` |
| `generalist` | NVIDIA NIM `nvidia/llama-3.3-nemotron-super-49b-v1.5` | MiniMax `MiniMax-M2.7` |
| `memory` | NVIDIA NIM `deepseek-ai/deepseek-v4-flash` | MiniMax `MiniMax-M2.7` |

Important mismatch: old docs/AGENTS text says "all roles use MiniMax". That is
outdated. New docs should point to `src/lib/model-map.ts` until Bifrost/DB
routing lands.

### Model router

Current router:

- `src/lib/model-router.ts`
- `src/lib/model-router/*`
- `src/lib/rate-limiter.ts`
- `src/providers/*`

What it does:

- virtual role -> real model/provider;
- per-provider rate limiting;
- retry on 5xx;
- capped fallback;
- streaming fallback;
- `isOverloadedFor(provider)`.

Problem: routing/fallback/rate-limit/cost/metrics are infrastructure concerns
inside app code. This should move to Bifrost.

### Database and memory

Current schema version: `PRAGMA user_version = 16`.

Core tables:

- `layer1_focus`
- `layer2_context`
- `layer3_archive`
- `layer4_log`
- `shared_memory`
- `agent_memory`
- `memory_edges`
- `tasks`
- `scheduler_state`
- `tg_messages`
- `chats`
- `chat_messages`
- `metrics_log`
- `code_tools`
- `freelance_leads`

Memory state:

- 4-layer memory exists.
- Shared memory exists.
- Markdown-first storage pattern exists.
- FTS exists for context/archive/shared/log/telegram.
- sqlite-vec is used for semantic search.
- NVIDIA embed/rerank models are used.
- Memory status/confidence/kind/access/salience/decay work has landed enough to
  be treated as current code, not future scope.
- Memory-v2 follow-ups that appear landed in code/tests: reflect promotion
  (`runReflect`), forgetting curve (`applyForgettingCurve`), cross-layer dedup
  (`runCrossLayerDedup`), and agent-only curation tools
  (`memory_link`/`memory_supersede`/`memory_promote`/`memory_reflect`).
- `memory_edges` exists with edge kinds:
  - `derives`
  - `relates`
  - `contradicts`
  - `supersedes`
- Edges have admin/read surface via `/v1/memory/edges` and related endpoints.

Memory gaps:

- No bi-temporal facts yet: no `valid_from`, `valid_to`, `observed_at`.
- Edges are not yet first-class in retrieval scoring.
- Sleep-time agent is mostly night-cycle logic, not a first-class role.
- Memory blocks are not yet explicit editable units.
- Memory-v2 docs still need reconciliation against landed code before Phase 3
  contracts are written. Do not reopen M-06/M-08/M-09/M-10 unless a fresh audit
  proves the implementation or tests are missing.

### RAG

Current RAG:

- FTS + vec + RRF + rerank pipeline.
- Shared/context/archive/log paths exist.
- NVIDIA embed/rerank provider path exists.

Direction:

- Keep SQLite + sqlite-vec.
- Add edge-walk and temporal validity into retrieval.
- Do not add Qdrant/Neo4j/Kuzu until single-user scale breaks.

### MCP tools

Current registry lives in `src/mcp/registry/*`.

Tool families:

- memory
- log
- embed
- rag
- report
- tasks
- telegram
- web/playwright
- agent meta
- code tool management

Gaps:

- Dynamic external MCP server registry is not there yet.
- Marketplace sync is not there yet.
- Tool scopes are code/config-driven, not UI-managed.
- MCP security allowlist should become explicit before marketplace install.
- Approval flow for externally visible or destructive actions is incomplete.
  `tg_send_message` is public and has spam/delivery guards, but it is not a
  general human approval gate for replies, payments, email/SMS, tool install,
  DB mutation, or code-tool network access.

### Agent pipeline

Current pipeline:

- pre -> main -> post phases;
- direct mode exists;
- room/arbitration exists;
- pre injects focus/RAG executive context;
- post hippocampus extracts memory writes;
- night-cycle consolidates and prunes.

Gaps:

- Post hippocampus still needs focused write cap contract finalized.
- Structured output is ad hoc, not BAML-backed.
- Prompt regression testing is absent.
- Durable/checkpointed phase execution is not implemented.

### Arbitration room

Current arbitration exists under `src/pipeline/arbitration/*`.

It is local/in-process:

- classify;
- dispatch to specialists;
- weighted synthesis;
- abort tests exist.

Direction:

- Keep local room.
- Later add A2A participant adapter for remote agents.
- Do not start A2A before gateway + pool are stable.

### Tasks and autonomy

Current `tasks` table exists and has REST/MCP surfaces.

Current missing piece:

- No `agent_tasks` table in code.
- No `src/scheduler/agent-pool/*`.
- No `done_with_artifact`.
- No artifact-producing autonomous pool.

Existing docs `docs/tasks/refactor/39..42` are the current PR-C backlog for
that work.

### Telegram

Current Telegram state:

- Bot API via Grammy.
- MTProto userbot via GramJS/Telegram package.
- `tg_messages` table + FTS.
- Telegram tools and routes exist.
- Poller/commands/notify modules exist.

Gaps:

- Work-chat ingest policy UI is missing.
- Task extraction from Telegram into `agent_tasks` is missing.
- Per-chat privacy/PII controls need UI and strict defaults.

### Frontend

Current frontend:

- Nuxt app under `web/`.
- Pages: `web/app/pages/index.vue` (chat route), `memory.vue`, `tasks.vue`,
  `freelance.vue`.
- Components/composables are partially split.

Direction:

- Rewrite as workspace shell after backend stabilization.
- No landing page.
- Modules should be lazy, self-contained, and tied to stable backend contracts.

### Codebase map for future workers

This spec is intentionally high-level. Before decomposition, workers need this
map so they do not treat established modules as orphan code:

- `src/app/*` — app bootstrap, dependency wiring, schedulers, shutdown,
  night-cycle controller.
- `src/routes/*` — Elysia HTTP routes.
- `src/services/*` — service layer for chat, memory, auth, agent workflows.
- `src/repositories/*` — repository layer over SQLite table modules.
- `src/db/*` — schema, migrations, low-level table operations.
- `src/lib/model-map.ts`, `src/lib/model-router/*`, `src/providers/*` — current
  provider routing path until Bifrost parity lands.
- `src/lib/personas/*` — persona/profile source for role prompts.
- `src/mcp/registry/*` — tool definitions and scopes.
- `src/mcp/executor/*` — execution facade used by REST/MCP/agent-loop.
- `src/pipeline/agent-pipeline/*` — chat pre/main/post path.
- `src/pipeline/agent-loop/*` — autonomous/interactive agent loop, dynamic
  tools, code tools, prompt blocks.
- `src/pipeline/arbitration/*` — local arbitration room.
- `src/pipeline/night-cycle/*` — scrub/translate/compress/archive, reflect,
  dedup, janitor, pruning.
- `src/rag/*` — FTS/vec/RRF/rerank retrieval.
- `src/scheduler/freelance/*` — freelance lead side workflow.
- `src/telegram/*` — Bot API and MTProto userbot integration.
- `web/app/*` — current Nuxt app.

## Target Shape

### Backend components

```text
Clients
  VS Code / Continue
  Web UI
  Telegram
  future: CLI/mobile/A2A clients

Subbrain API (Bun/Elysia)
  Auth
  Chat API
  Memory API
  Tasks API
  Telegram API
  MCP transport

Core logic
  Agent pipeline
  Agent pool
  Arbitration room
  Memory service
  RAG service
  Scheduler/night-cycle

Data
  SQLite + FTS5 + sqlite-vec

Side-cars
  Bifrost: LLM gateway (Phase 1)
  cliproxy: optional OpenAI-compat (existing)
  Langfuse OR Laminar: traces (Phase 5, single bounded decision)
  out-of-scope: Windmill/n8n until concrete workflow surfaces
```

### Frontend modules

Future workspace shell modules:

- `chat`
- `roles`
- `providers`
- `mcp`
- `skills`
- `tasks`
- `memory`
- `tg-data`
- `runs`
- `settings`

## Roadmap

### Dependency shape

The phases below are an organizational order, not a strict serial graph.
Recommended dependency shape:

```text
Phase 0 -> Phase 1 foundation
              |-> Phase 2 agent pool
              |-> Phase 3 memory finalization
              |-> Phase 4 structured prompts/evals
              |-> Phase 5 observability
Phase 2 + Phase 3 + Phase 5 -> Phase 6 A2A
Stable backend APIs -> Phase 7 frontend workspace
```

Phase 2-5 can be decomposed into parallel tracks after the Phase 0 docs reset
and once their write scopes are separated. Phase 7 should not be a big-bang
rewrite: decompose by shell first, then module by module.

### Cross-cutting scopes not yet decomposed

These are part of the main scope even if they are not numbered as standalone
phases yet:

- Auth hardening and explicit approval flow for destructive/external actions.
- Telegram privacy controls, ingest policy, and task extraction.
- MCP transport hardening: explicit allowlist, marketplace install policy,
  external server registry boundaries.
- Scheduler/night-cycle hardening: budgets, retry limits, janitor safety,
  transcript/audit artifacts.
- SQLite backup/restore, retention, VACUUM/analyze/FTS maintenance, migration
  rollback drills.
- Cost controls: per-provider/per-role budgets, autonomous-loop quotas, alerting.
- Windmill/n8n side-car decision: either define a later automation track or move
  it to anti-scope until there is a concrete workflow.

### Phase 0 — Documentation and contract reset

Goal: one truthful plan and small contracts for Kimi/agent-teams.

Tasks:

- Archive obsolete docs.
- Keep active task contracts visible under `docs/tasks/**`.
- Make this file canonical.
- Sync `AGENTS.md`, README/model docs, and active docs with `src/lib/model-map.ts`.
- Audit existing task-contracts before writing new ones:
  - mark DONE contracts as done/archive candidates;
  - flag stale contracts that reference deleted docs;
  - flag conflicts with this main plan;
  - keep PR-C `39..42` visible as the current agent-pool backlog.
- Create a coverage matrix from this scope to future contracts, but do not
  dispatch implementation yet.

Acceptance:

- New plan says what exists vs what does not exist.
- No new implementation yet.
- Future decomposition has a clear source-of-truth map and stale-contract list.

### Phase 1 — Bifrost gateway

Goal: remove custom app-level LLM routing pressure.

Work:

- Add Bifrost side-car to compose.
- Add minimal config for MiniMax, NVIDIA, OpenRouter, openai-compat.
- Add `GatewayClient` provider compatible with current `LLMProvider`.
- Route chat/stream through Bifrost behind feature flag.
- Keep raw NVIDIA embed/rerank path for now.
- Add tests for fallback, stream, auth error, overload/status mapping.
- Preserve `cliproxy` as an optional OpenAI-compat bridge; do not confuse it
  with Bifrost routing.

Non-goals:

- No roles UI.
- No DB-driven model editor yet.
- No removal of old router until parity is proven.

### Phase 2 — Agent tasks and pool

Goal: autonomous work produces artifacts.

Work:

- Land `agent_tasks`.
- Add pool engine.
- Add `done_with_artifact`.
- Add runners.
- Add digest and per-type rate limits.
- Add parallelism only after single-runner is stable.

Non-goals:

- No frontend rewrite in this phase.
- No A2A in this phase.

### Phase 3 — Memory-v2 finalization

Goal: memory becomes graph/temporal/editable.

Open inputs:

- `docs/tasks/agent-teams/02-memory-bi-temporal.md` — draft contract (foundation).
- `docs/tasks/memory-v2/M-12-archive-confidence-real.md` — archive HIGH/LOW→REAL (XS effort).
- `docs/tasks/refactor/43-prd-hippocampus-rewrite.md` — hippocampus
  write-cap PRD (orphan, no phase mapping until now).
- `docs/tasks/refactor/44-pre-character.md` — persona/teamlead/memory final
  pass, depends on 43.

Work:

- Add bi-temporal columns or table.
- Add temporal validity filters to retrieval.
- Add edge-walk boost.
- Add memory blocks.
- Promote sleep-time role.
- Hippocampus write-cap (PR-43).
- Persona final pass (PR-44).
- Add curation tests.
- Reconcile Phase 3 with landed Memory-v2 tasks before writing contracts:
  reflect, forgetting curve, cross-layer dedup, and curation tools appear
  present in code/tests and should be dependencies, not duplicate work.

Non-goals:

- No external memory framework dependency.
- No separate graph DB.

### Phase 4 — Structured prompts and evals

Goal: make LLM I/O testable.

Work:

- Add BAML for high-value structured outputs.
- Add Promptfoo regression tests.
- Cover hippocampus, task extraction, arbitration summary, pool artifact outputs.

Non-goals:

- No prompt UI yet.
- No full migration of every prompt.

### Phase 5 — Observability

Goal: see what happens in runs.

Work:

- Add OpenTelemetry/OpenLLMetry instrumentation.
- Make a bounded Langfuse vs Laminar decision before implementation.
- Trace request -> pre -> main -> tools -> post -> writes.
- Add cost/latency summary.

Non-goals:

- No custom Langfuse clone.

### Phase 6 — A2A arbitration

Goal: make arbitration room extensible to remote participants.

Work:

- Add participant interface.
- Keep local participants working.
- Add A2A transport adapter behind feature flag.
- Add transcript artifacts.

Non-goals:

- No remote code execution.
- No marketplace of agents.

### Phase 7 — Frontend workspace rewrite

Goal: one control room for the system.

Work:

- Shell/sidebar/tabs.
- Modules listed above, split into bounded module passes.
- Runs/traces viewer.
- Memory edges/temporal UI.
- Provider/MCP/role management.
- Keep existing backend APIs stable during frontend passes; API redesign belongs
  in earlier backend phases.

Start only after:

- Bifrost is stable.
- Agent pool has stable APIs.
- Memory-v2 API shape is known.

`docs/tasks/04-web-ui-fixes.md` PR-4 (full UI redesign) is superseded by
Phase 7 — task is partial (bug fixes done), the redesign item folds here.

## Runtime Architecture Track (Variant B, parallel to Phases)

Один процесс, один deploy. Меняется только внутренняя структура `src/`. Цель —
не вынудить ядро править ради будущих расширений (portfolio + соц-сети
plugins). Edges с Phases:

```text
A1 ≈ Phase 0 (mechanical, ground floor)
A2 ≈ Phase 1 (alongside Bifrost — gates вытащены в hooks)
A3 → after Phase 2 (frozen plugin API)
A4 → out of round (first external plugin as smoke test)
```

### A1 — Bun workspaces split

`git mv` + per-package `package.json` + import-path правка. Поведение
бит-в-бит. Target layout (one process):

```text
packages/
  core/        ← src/lib/{logger,http-client,fts-utils,api-envelope,messages,model-map}
                  + src/db/ + src/repositories/
  providers/   ← src/providers/ + src/lib/rate-limiter.ts + src/lib/model-router*
  plugin/      ← types-only: Hooks, tool(), ToolDefinition, ToolResult
  agent/       ← src/pipeline/ + src/mcp/ + src/scheduler/ + src/lib/personas/
  server/      ← src/routes/ + src/index.ts
  web/         ← существующий web/app
  sdk/         ← deferred to A4
```

Acceptance: `bun test`, `bunx tsc --noEmit`, `docker compose build && up -d`
проходят без изменений. Per-package tsc заметно быстрее.

Out of scope: hooks pipeline, plugin loader.

### A2 — Plugin runtime + hooks pipeline (internal only)

Types-only пакет `@subbrain/plugin`. `INTERNAL_PLUGINS` array. Hooks:
`tool.execute.before/after`, `chat.params`, `chat.system.transform`,
`permission.ask`. ToolResult расширяется до
`success | failure | rejected | denied | timeout`.

Migrate в plugins:

- `src/scheduler/freelance/*` → `@subbrain/plugin-freelance-scout`.
- `telegram-spam-gate.ts` → hook `tool.execute.before` для `tg_send_message`.
- `code-tool-validators.ts` → hook на create_code_tool/edit_code_tool.
- `STATEFUL_CLIENT_CODE_TOOLS` Set → плагин подгружается только при
  `agentMode === "scheduled"`.

Risk: scattered гейты — тонкие проверки. Каждая plugin migration требует
integration test, иначе spam protection ломается молча.

Out of scope: external loader, npm publish.

### A3 — External plugin loader

`subbrain.config.ts`:

```ts
export default {
  plugins: [
    "@subbrain/plugin-freelance-scout",
    ["@subbrain/plugin-tg-gates", { chatId: process.env.TG_CHAT_ID }],
    "./local/portfolio-plugin",
  ],
}
```

Plugin API freeze. Опционально публикуем `@subbrain/plugin@0.1.0` или держим
internal.

### A4 — First external plugin (out of round)

Portfolio или одна соц-сеть. Уроки → API tweaks. Только после A4 решение по
multi-process (Variant C).

## Anti-scope

- Do not replace Subbrain with Mastra/LangGraph/CrewAI.
- Do not replace SQLite with Qdrant/Neo4j/Postgres until scale demands it.
- Do not build a JS plugin eval system.
- Do not auto-install arbitrary MCP servers.
- Do not build training/fine-tuning UI.
- Do not introduce Kubernetes for a single VPS.
- Do not let autonomous agents send money, email, SMS, Telegram replies, or
  destructive ops without an explicit approval flow.

Anti-scope is not enforcement. Anything in anti-scope that can happen through
current tools must have an implementation track or an explicit disabled-by-default
gate before autonomous mode is trusted.

## Risk Register

| Severity | Risk | Current state | Scope response |
|---|---|---|---|
| HIGH | No general approval flow for destructive/external ops | Memory approval exists; `tg_send_message` has delivery/spam guards; no universal approve/deny gate. | Add security/approval foundation before higher autonomy. |
| HIGH | Provider/fallback outage | Most roles fallback to MiniMax; `coder` primary/fallback are both NVIDIA; fallback attempts are capped at 1. | Bifrost plus provider diversity and health-aware routing. |
| HIGH | Cost/quota runaway | Metrics and some session quotas exist, but no global spend budget for autonomous loops. | Add per-role/provider budget controls and alerts. |
| HIGH | PII exposure from Telegram/raw logs | Night-cycle scrubs archive path; Telegram ingest stores searchable raw messages. | Add ingress privacy policy, per-chat defaults, redaction/retention rules. |
| HIGH | Code-tool sandbox is not a security boundary | Worker sandbox exposes `fetch`; comments explicitly warn about exfiltration. | Disable creation in scheduled mode by default and add network allowlist/subprocess isolation before broader use. |
| HIGH | MCP marketplace/install surface | Registry is code/config-driven; allowlist is not explicit enough for marketplace installation. | Add MCP security track before external server marketplace. |
| MEDIUM | Frontend rewrite big-bang | Current UI works but is partial; Phase 7 could sprawl. | Split shell and modules; require stable backend APIs first. |
| MEDIUM | Single-user claim vs multi-source primitives | Schema already has `source`, `agent_id`, chat origins. | Keep single-user product stance, but do not assume single-agent data boundaries. |

## Contract Writing Rules

Every concrete task for Kimi/agent-teams must include:

- goal;
- current code state;
- dependencies;
- allowed write paths;
- hard no-go list;
- diff boundary;
- file count and LOC budget;
- performance budget when the task touches hot paths, loops, retrieval, or
  provider calls;
- security/privacy considerations when the task touches auth, Telegram, tools,
  code execution, logs, memory, providers, or traces;
- exact tests;
- integration test plan;
- acceptance commands;
- rollback plan;
- deployment sequence when compose/env/migration/runtime behavior changes;
- parent review checklist;
- ambiguity resolution protocol;
- escape hatch;
- output contract.

Kimi K2.6 gets bounded work. It does not make architecture decisions. If it
hits ambiguity, it returns a failure packet instead of inventing a new design.

Ambiguity protocol: when code contradicts the contract, required files are
missing, a migration version changed, tests fail before edits, or the work would
exceed the write/LOC budget, the worker stops and returns `FAIL: <category>:
<short reason>` with no speculative redesign.

## Existing task contract inventory

Decomposition source. Каждый файл — pre-existing draft, full PRD, или backlog
item. Phase mapping ниже = вход для wave-плана.

### DONE (reference only)

`docs/tasks/01-rag-for-telegram-reports.md`,
`docs/tasks/02-telegram-polling.md`,
`docs/tasks/03-freelance-search-mode.md` (first pass),
`docs/tasks/05-post-refactor-feedback.md` (A1-A4, B4),
`docs/tasks/06-openai-compat-provider.md`,
`docs/tasks/code-tools-poisoning-fix.md`,
`docs/tasks/refactor/01..15` (Chapter 1),
`docs/tasks/refactor/28+` (Chapter 3 file-cap),
`docs/tasks/refactor/38-prb-fix-completion.md`,
`docs/tasks/memory-v2/M-01..M-11, M-13, M-14, M-FINAL{,2,3}`.

### ACTIVE / PARTIAL

- `docs/tasks/04-web-ui-fixes.md` — bugs done, redesign → Phase 7.
- Refactor Chapter 2 (PR 17-27) sub-PRs: AuthService → Phase 8a;
  MemoryService → Phase 3; ChatService/AgentService → fold into Phase 1;
  Repository layer → already DONE in `src/repositories/` (mark Ch.2 README).

### DRAFT contracts → Phase mapping (1:1)

- `docs/tasks/agent-teams/01-bifrost-gateway.md` → **Phase 1**.
- `docs/tasks/agent-teams/02-memory-bi-temporal.md` → **Phase 3**.
- `docs/tasks/agent-teams/03-baml-promptfoo.md` → **Phase 4**.
- `docs/tasks/agent-teams/04-observability.md` → **Phase 5**.
- `docs/tasks/agent-teams/05-a2a-arbitration.md` → **Phase 6**.

### ORPHAN → resolved here

- `docs/tasks/refactor/43-prd-hippocampus-rewrite.md` → **Phase 3**.
- `docs/tasks/refactor/44-pre-character.md` → **Phase 3** (depends 43).
- `docs/tasks/refactor/39..42` → **Phase 2** (agent-pool backlog).
- `docs/tasks/memory-v2/M-12-archive-confidence-real.md` → **Phase 3**.

### NEEDS audit pass (no status header)

- `docs/tasks/task-store/Phase-3..6` — predicted mapping:
  - rate-limit → Phase 3 or Phase 8a;
  - TG reliability → Phase 8 (Telegram cross-cut);
  - digest → Phase 5;
  - UI → Phase 7.
  Acceptance for audit: status header `Status: ACTIVE | DRAFT | DONE` или
  файл удаляется.

### NEW contracts (no draft, must be written)

- **Phase 0 docs sync** — AGENTS.md/README ↔ model-map.ts; archive obsolete docs.
- **A1 workspaces split** — Runtime Architecture Track Phase 1.
- **A2 plugin runtime + hooks pipeline** — Runtime Architecture Track Phase 2.
- **Phase 8a approval flow** — destructive op gate.
- **Phase 8b MCP allowlist** — explicit policy (foundation for marketplace).
- **Phase 8c SQLite backup/restore** — must-have before serious autonomy.
- **Phase 8d scheduler hardening** — idempotent restart, checkpointed.
- **Phase 8e Telegram PII gates** — ingest-time scrub, per-chat policy UI.
- **Phase 8f cost controls** — per-role budget hard stop.

### Wave plan (preview)

- **Wave 1 (foundation, sequential):** Phase 0 docs sync, A1 workspaces.
- **Wave 2 (parallel after W1):** Phase 1 Bifrost, A2 hooks pipeline,
  Phase 2 agent-pool (39-42), Phase 4 BAML, Phase 5 observability.
- **Wave 3 (parallel after W2):** Phase 3 cluster (02 bi-temporal, M-12, PR-43,
  PR-44), Phase 6 A2A.
- **Wave 4 (parallel, security tier, can start after Phase 1):** 8a approval,
  8c backup, 8e PII, 8b MCP allowlist.
- **Wave 5 (deferred):** Phase 7 frontend rewrite, A3 plugin loader,
  8d scheduler hardening, 8f cost controls.

Финальный wave-plan живёт в `docs/specs/wave-plan-2026-05.md`.
