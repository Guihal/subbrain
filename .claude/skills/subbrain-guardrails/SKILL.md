---
name: subbrain-guardrails
description: Use whenever editing src/ or web/app/ in subbrain repo. Enforces lessons from refactor docs (PR 01-15) so re-refactor not needed. Covers file-size cap, Promise.allSettled, tool timeouts, AbortSignal compose, FTS sanitize, transactions, http-client, logger contract, model-map, SSE close, N+1, validation boundary, single-source registries.
---

# Subbrain guardrails

Invoke before writing or editing any file in `src/`, `web/app/`, `scripts/`, `tests/`. Prevents repeat of the 15-PR refactor (see `docs/01-refactor-plan.md`, `docs/02-audit.md`, `docs/tasks/refactor/`).

Follow as checklist. If new code violates rule — rewrite before commit.

## 1. File size + split

- Hard cap: **150 lines** per file (lowered from 250 in 2026-04), one responsibility. Pre-existing legacy oversize files split поэтапно, не grow в новых PR.
- Big file smell → split now, not later. Template layouts:
  - Orchestrator ≤100 lines → delegates to `phases/`, `steps/`, `tables/`, `post/`, `pre/`.
  - Route file: handler thin, logic in `lib/`/`pipeline/`.
  - Vue page: shell ≤100 lines, rest in `components/<page>/*.vue` + generic composable factory.
- Exceptions (do not split): `src/pipeline/agent-loop/system-prompt.ts`, `src/lib/model-map.ts`, `src/rag/pipeline.ts`, MCP registry files, telegram modules.

## 2. Concurrency + cancellation

- N parallel upstreams → `Promise.allSettled`, never `Promise.all`. One failure must not kill siblings.
- Every fan-out gets an `AbortController`; signal composed with external signal and passed down to `ModelRouter.chat` → providers. Providers check `signal.aborted` before start + inside stream callback.
- Every tool call in agent-loop wrapped in `Promise.race([exec, timeout(N)])`. Scopes in `tool-runner.ts`: `web_*`=15s, `memory_*`=3s, `embed_*`=5s, `consult_*`=20s, default=5s. Timeout returns `ToolError{code:"timeout"}` — never throws.
- Shared mutable limits (rate-limiter) use atomic `tryAcquire()` under `Mutex` — no check-then-act race.
- Fallback chain cap: `MAX_FALLBACK_ATTEMPTS=1`. On exhaustion throw `UpstreamExhaustedError` → 502 via central `onError`. Direct mode does not cascade.

## 3. Streaming + SSE

- Any long SSE sends `: ping\n\n` every 5s via `setInterval`. `.listen({ idleTimeout: 255 })` mandatory.
- `wrapStreamForChat` keeps `isClosed` flag. On `signal.aborted || cancel()` → set flag, abort inner reader, **no DB writes after close**. Regression test: client disconnects mid-stream → 0 partial rows.
- SSE chunk parsing lives in `providers/sse-parser.ts`. New provider = reuse, not reimplement.

## 4. DB + RAG

- Insert + side-effect (embed/index) → wrap in `db.transaction()`. Side-effect fail = rollback + warn + retry next cycle. Never leave row with NULL-vector.
- Batch lookups: `WHERE id IN (?,?,...)` via `getContextMany` / `getArchiveMany`. No loops of `SELECT` per id.
- Read metadata (e.g. `updated_at`) once into `RAGResult`, reuse downstream — no extra SELECT.
- FTS user input → **always** `sanitizeFtsQuery` from `lib/fts-utils.ts`. Includes tags, search boxes, night-cycle inputs. Raw `"`, `:`, `*` will throw at MATCH.
- Migrations atomic: `db.transaction()` + per-statement `.run()`. Never `db.exec` multi-statement (swallows errors).
- Mutations on allow-listed tables → `updateRow(table, ALLOW, id, patch)` from `db/tables/update-row.ts`. New columns → update the allow-list next to the table.

## 5. HTTP + providers

- All outbound `fetch` → `src/lib/http-client.ts` (`fetchJson` / `fetchStream`). Default 60s timeout, 180s for Copilot streams. External signal composed via `AbortSignal.timeout()`. No raw `fetch` in new code.
- New provider: reuse `sse-parser.ts` + `http-client.ts`. Caller-specific = request/response mapping only.
- `Message` typing: use `reasoning_content?: string`, `name?: string` on type. No `(m as any)` casts.

## 6. Validation + types

- Every route input validated via Elysia TypeBox `t.Object`/`t.Union([t.Literal])`. Never `role: string`. Normalize inbound via `normalizeMessages()` (`src/lib/messages.ts`) — all ingress (routes, autonomous, telegram) goes through it.
- Provider response: runtime-validate before `as Message`. Defaults on missing fields.
- `AgentContext` is a discriminated union: `PublicContext` (only `executor`) vs agent context (all fields). No `ctx.router!` non-null assertions.
- `ToolResult` single shape: `{ok:true, data} | {ok:false, error:{code, message}}`. Registry wraps handlers.
- `ProviderResponse` closed union `text | tool_calls | mixed`. No `any`-cast in `routes/chat.ts`.
- `tsc --noEmit` must stay exit 0. TS errors are blockers, not warnings.

## 7. Logger contract

- Signature: `logger.info(stage: string, message: string, extra?)`. One-arg call silently breaks — stage gets text, message is undefined.
- In a module top: `const log = logger.child("copilot")`, then `log.info("...")`. Do not repeat stage per call.
- Meta values → `logger.formatForDb` (safe `JSON.stringify` + circular catch) before SQLite write.

## 8. Errors + envelopes

- Throw domain errors (`AppError`, `UpstreamExhaustedError`, `ToolError`, `HttpError`, `HttpAbortError`). Central `onError` in Elysia serializes to single JSON shape. No per-route `.onError` duplicates.
- 404: `{ error: { message } }` shape. Paginated lists: `{ items, total }` via `lib/api-envelope.ts` (`PaginatedResponse<T>` + `paginate(query, {page, pageSize, q})`). Routes must not reinvent pagination.
- Error body echoed to client: slice to ≤200 chars + regex-redact `/api[_-]?key|authorization|token|bearer/gi`.

## 9. Single sources of truth

- Virtual roles → `src/lib/model-map.ts`. Never hardcode model IDs. `EMBED_MODEL` / `RERANK_MODEL` constants live there too.
- MCP tools → declared once in `src/mcp/registry/*.tools.ts` (schema + wiring). Domain logic in `src/mcp/tools/*`. No parallel switch-cases. Scope: `public` | `agent-only`.
- Tool dispatcher = array `resolvers: ToolResolver[]` with priority (registry → dynamic → code); new category = push to array, no new switch.

## 10. Tests

- `bun:test` only (`describe/test/expect`). Never top-level code + `process.exit` — `bun test` picks it up and kills runner.
- Live/integration tests → `tests/*.live.ts`. `bun test` ignores. Requires server on `:4000`.
- Test DB → `data/test.db`, cleaned by test itself. Never point at `data/subbrain.db`.
- New concurrency primitive / timeout / abort / compose → regression test required (cancel after 2nd chunk, 100 parallel at limit=10, etc).

## 11. Security / boundary

- `timingSafeEqual` + `crypto.subtle.digest('SHA-256')` on both sides for token compare. Fixed-length buffers.
- `scripts/seed.ts` + other destructive scripts require `--confirm` or non-prod path. Default = `exit 1`.
- `/v1/logs` masks `api_key|authorization|token|bearer` by default; `?raw=1` opts out.
- Sandbox (`agent-loop/code-tools/sandbox.ts`): `throw Error("sandbox_unavailable")` when `typeof Worker === "undefined"`. No `new Function` fallback.

## 12. Docs

- When splitting dir / moving file: update CLAUDE.md paths + matching `docs/completed/*.md` in same PR.
- Closing a task: ✅ in `docs/02-audit.md`, strike row in `docs/01-refactor-plan.md`, `Status: DONE (PR #N)` in `docs/tasks/refactor/NN-*.md`.
- Large new subsystem → entry in `docs/repo-map.md` (when it exists) + 1-screen doc in `docs/completed/`.

## Red flags — stop + fix before commit

| Smell | Rule violated |
|---|---|
| `Promise.all([spec1, spec2, ...])` on upstream calls | §2 |
| `fetch(url, {...})` outside `http-client.ts` | §5 |
| `logger.info("long message text")` single arg | §7 |
| `.match('... ${userInput} ...')` on FTS | §4 |
| `insertArchive(...); await embed(...)` separate awaits | §4 |
| `(m as any).reasoning_content` | §5 |
| New model ID string-literal in pipeline/route | §9 |
| `role: string` in route schema | §6 |
| File over 150 lines growing | §1 |
| `process.exit` in `tests/*` | §10 |
| Raw `fetch` for streaming Copilot/Nvidia | §5 |
| `db.run("UPDATE ...")` hand-built in route | §4 |
| `ctx.router!.chat(...)` non-null assertion | §6 |
| `.onError(({error}) => {...})` duplicated in routes | §8 |
| `const { items, total } = ...` paginated hand-rolled | §8 |
