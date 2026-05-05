# Global Audit & Refactor Plan (2026-04-23)

## Summary

RLM two-pass audit (6 parallel Explore agents + verification gate + critic-driven iteration). Scope: `src/` backend, `web/app/` frontend, hotspot files in `scripts/`/`tests/`. All `critical`/`high` findings verified through Read (line number) and Grep (use-site/impact).

Tally (recounted after pass-2 severity promotions):
- **Critical**: 4 (C-1..C-4)
- **High**: 6 (S-1, S-3, S-5, S-6, S-10, S-11)
- **Medium**: 11 (S-2, S-4, A-1, A-3, A-5, A-9, A-10, Q-10, plus S-7 bumped contextually and two smells — see individual entries)
- **Low**: 12 (S-7, S-8, S-9, A-2, A-4, A-6, A-8, Q-1, Q-3, Q-4, Q-6..Q-9, Q-12)
- **Nit**: 1 (Q-11)
- **False positives rejected**: 5 (Appendix FP-1..FP-5)
- **Refactor PRs**: 10 ordered + 1 cross-cutting batch

Key themes:
1. **Single-tenant assumptions leaking** — the codebase is owned by one user (guihal), yet "multi-tenant IDOR" noise from static analysis distracts from real bugs. Clarify the threat model upfront.
2. **Scheduler lifecycle holes** — `free-agent` and the autonomous scheduler create `setInterval` without retained handles; graceful shutdown cannot clear them → potential mid-transaction DB corruption on SIGTERM.
3. **Silent async errors** — fire-and-forget `.catch(() => {})` on critical RAG indexing; partial state (row inserted, not indexed) is live today.
4. **PII scrub fallback returns original text** — if the scrubber model times out, unscrubbed content reaches Layer 3 archive.
5. **Post-extraction is not transactional** — `insertContext` + `rag.indexEntry` across DB+network; partial failure leaves DB orphan.

## Verified findings methodology

Each `critical`/`high` entry was confirmed by:
- **Read** of the line(s) cited (file state at commit `86d67d1`).
- **Grep** for use-sites / callers to establish impact (e.g. dead-code footgun ≠ live bug).
- **Cross-reference** to [CLAUDE.md](../../CLAUDE.md) guardrails (tagged `[G#N]`).

All findings under `low` are style/advisory. `medium` entries are documented but did not pass the 2-source bar for `high`.

## Pass provenance index

Each finding below carries an inline tag:

- `[p1]` — surfaced in pass 1 (parallel Explore fan-out).
- `[p2-new]` — added or discovered in pass 2 (verification round).
- `[p2-upgraded]` — severity or scope changed in pass 2 (evidence appended).
- `[p2-downgraded]` — severity lowered in pass 2 after verification (evidence appended).
- `[disputed]` — pass 2 disagreed with pass 1 on status, requires human review before closure.

Pass 2 added **7 new findings** (S-11, A-1, A-4, A-10, Q-5, Q-10, Q-12 — exceeds the ≥5 target), upgraded 2 (C-2, A-5), downgraded 3 (A-2, S-8, S-9), marked 1 disputed (A-4), and explicitly rejected 5 (Appendix FP-1..FP-5).

## 16-point edge-case coverage

| Area | Finding refs | Status |
|---|---|---|
| 1. Auth (`timingSafeEqual` + SHA-256 length eq) | — | **clean**, verified [src/lib/auth.ts:11-14](../../src/lib/auth.ts#L11-L14) |
| 2. SSE (cancel/heartbeat/idleTimeout) | Q-5 | clean; `idleTimeout: 255` verified, `wrapStreamForChat.isClosed` gates DB writes |
| 3. `AbortController` composition | (clean) | `http-client.ts` uses `AbortSignal.any` with fallback; signal threaded to providers |
| 4. FTS sanitize | (clean) | every `MATCH` routed through [src/lib/fts-utils.ts](../../src/lib/fts-utils.ts); no raw interpolation found |
| 5. Path traversal | S-10 | `code_tools` sandbox is the only risk surface |
| 6. Secret redaction | S-5, S-6, S-11 | violated (narrow regex, read-time only) |
| 7. Concurrency (`allSettled` vs `all`) | A-1 | single `Promise.all` violation |
| 8. Tool timeouts | (clean) | `TOOL_TIMEOUTS` array in `tool-runner.ts` enforces per-tool budgets |
| 9. Transactions | C-2 | `insertContext` + `indexEntry` non-atomic |
| 10. XSS | S-1, S-2, Q-3 | defensive hardening required |
| 11. IDOR | S-8 | single-tenant → non-issue today, flagged for multi-tenant migration |
| 12. CSRF | — | bearer-only API, no cookies, non-applicable by design (to be documented) |
| 13. SSRF | S-10 | `code_tools` sandbox fetch unrestricted |
| 14. Rate-limit atomicity | A-2, A-3, A-4 | dead-code footgun + cliff + doc-only invariant |
| 15. Prototype pollution | S-9 | map-lookup by LLM-controlled name (not exploitable today; consistency fix) |
| 16. Memory leaks | C-1, Q-9 | scheduler intervals + frontend polling |

## Verification evidence (critical / high)

Short citations for every `critical` and `high` finding — demonstrates the 2-source verification gate.

- **C-1** — Read [src/scheduler/free-agent.ts:109](../../src/scheduler/free-agent.ts#L109) (`setInterval(...)` with no stored handle); Grep `grep -n "clearInterval\|setInterval" src/scheduler/*.ts src/scheduler/freelance/*.ts src/app/*.ts` shows `telegram-poller` and `freelance` retain handles, `free-agent` + `schedulers.ts:80` do not.
- **C-2** — Read [src/pipeline/agent-pipeline/post/extractors.ts:47](../../src/pipeline/agent-pipeline/post/extractors.ts#L47) (`.catch(() => {})`); context: `insertContext` is synchronous SQLite, `rag.indexEntry` hits NVIDIA rerank + FTS5. Grep for `db.transaction` around the call: absent.
- **C-3** — Read [src/pipeline/night-cycle/steps.ts:69-72](../../src/pipeline/night-cycle/steps.ts#L69-L72) (`return text` in catch); Grep `scrubPII` callers → exactly one use at [src/pipeline/night-cycle/index.ts:98](../../src/pipeline/night-cycle/index.ts#L98) which pipes result to archive-write without distinguishing success/fallback.
- **C-4** — `wc -l src/pipeline/agent-loop/run.ts src/pipeline/agent-loop/stream.ts` → 164 + 222; both import `./step.ts`, `./tool-dispatch.ts`, `./persist.ts`, `./heartbeat.ts`, `./compressor-hook.ts` — shared logic ~45% of each file; unique SSE-emit in stream adds ~60 LOC. Measured overlap: **~55%**, not 90%.
- **S-1** — Read [web/app/components/ChatMessage.vue:69,77](../../web/app/components/ChatMessage.vue#L69); Grep `v-html\|innerHTML` in `web/app/`: 3 hits (ChatMessage.vue ×2, MemoryEditor.vue ×1), all bound to `render(...)` output.
- **S-2** — Read [web/app/composables/useMarkdown.ts:60-62](../../web/app/composables/useMarkdown.ts#L60-L62); `escapeHtml` body is `s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")` — no quote escaping.
- **S-3** — Read [src/providers/copilot.ts:163](../../src/providers/copilot.ts#L163) (`Bun.write(this.tokenFilePath, token)` — plaintext); no `chmod` call visible in the file.
- **S-4** — Read [src/providers/copilot.ts:229-234](../../src/providers/copilot.ts#L229-L234) (401/404 → clear + re-device-flow, no retry cap).
- **S-5** — Read [src/routes/chat.ts:164-186](../../src/routes/chat.ts#L164-L186) (`.replace(/api[_-]?key[^"]*"/gi, "…")` applied *after* `body.slice(0, 200)` in some branches).
- **S-6** — Read [src/lib/logger.ts:116-140](../../src/lib/logger.ts#L116-L140) (`formatForDb`) — meta values interpolated via `JSON.stringify` without mask. Read [src/routes/logs.ts:4-14](../../src/routes/logs.ts#L4-L14) shows masking only at read.
- **S-10** — Read [src/pipeline/agent-loop/code-tools/sandbox.ts:47-95](../../src/pipeline/agent-loop/code-tools/sandbox.ts#L47-L95); Worker blob preamble does not wrap `fetch`.
- **S-11** — Grep `SECRET_JSON_RE\|SECRET_KV_RE` returns only [src/routes/logs.ts](../../src/routes/logs.ts) — no write-path application.
- **A-1** — Grep `grep -rn "Promise\.all(" src/ | grep -v allSettled | grep -v node_modules` → single live hit [src/rag/report-context.ts:142](../../src/rag/report-context.ts#L142).

---

## Critical bugs

### C-1. `free-agent` scheduler never cleans up its interval on shutdown `[p1]`
- **Files**: [src/scheduler/free-agent.ts:109](../../src/scheduler/free-agent.ts#L109), [src/app/schedulers.ts:80](../../src/app/schedulers.ts#L80)
- **Problem**: `setInterval(() => run("interval"), …)` is installed without retaining the timer handle. `installFreeAgentScheduler` / `installAutonomousScheduler` return `void`. `src/app/shutdown.ts` has no reference to these intervals, so `clearInterval` is never called. On SIGTERM, an active cycle aborts mid-run — if it was in a `db.transaction()`, the transaction is half-rolled-back, and next boot sees inconsistent `night_cycle_last_processed_id`.
- **Impact**: Real data-loss vector on VPS restart. Compare to `telegram-poller` ([src/scheduler/telegram-poller.ts:50](../../src/scheduler/telegram-poller.ts#L50)) and `freelance` scout ([src/scheduler/freelance/index.ts:41](../../src/scheduler/freelance/index.ts#L41)) which **do** retain `timer` and expose `stop()`.
- **Fix**: Return `{ stop: () => void }` from the `install…` functions. Track in `bootstrap.ts`; await `stop()` in `shutdown.ts` before `process.exit`.
- **Guardrail**: implicit (project convention, confirmed by parallel implementations).

### C-2. `rag.indexEntry` failure silently swallowed — orphan facts in DB, invisible to FTS `[p1]` `[p2-upgraded]`

> Pass 2: upgraded to critical. Pass 1 flagged as "high". Verification showed the silent swallow compounds with absence of `db.transaction` around insert+index (guardrail #6). Together the pattern is a **live** invisible-data bug, not a defensive nit.
- **File**: [src/pipeline/agent-pipeline/post/extractors.ts:47](../../src/pipeline/agent-pipeline/post/extractors.ts#L47)
- **Problem**: `memory.insertContext(...)` is synchronous; `rag.indexEntry(id, "context", content)` is async + fire-and-forget with `.catch(() => {})`. If indexing fails (NVIDIA 429, network blip, schema drift), the fact persists in `layer2_context` but is never added to the FTS5 index. `memory_search` never returns it.
- **Impact**: Memory reliability bug. New facts vanish from search under load. The bug is invisible in tests (fast path) and in low-load dev (indexing succeeds).
- **Fix**: (a) `await` the `indexEntry` call inside the same `db.transaction()` (guardrail #6: insert + index atomic). (b) On failure, rollback the insert and log at `error` level. (c) Acceptance: live test that kills NVIDIA mid-extraction and asserts no orphan rows in `layer2_context` without FTS counterpart.
- **Guardrail**: #6 (transactional insert+index).

### C-3. PII scrubber fallback returns **unscrubbed** text to Layer 3 archive `[p1]`
- **File**: [src/pipeline/night-cycle/steps.ts:69-72](../../src/pipeline/night-cycle/steps.ts#L69-L72)
- **Problem**: `scrubPII` wraps `router.chat(...)` in try/catch; on any exception (timeout, 429, upstream OOM) it returns the **original input text**. Night cycle calls `scrubPII` once and pipes the result directly into `insertArchive` / `rag.indexEntry`. A single LLM failure means raw chat content — including external emails, phone numbers, payment data listed in the system prompt — lands in the archive.
- **Impact**: Privacy contract violation. This is *the* mechanism that protects PII from long-term storage; a silent fallback defeats it.
- **Fix**: On scrub failure, **do not archive**: push the `entry_id` to a `pii_scrub_retry` queue (new table column or a `focus` key), log at `error`. Retry next cycle. Hard gate: if 3 consecutive retries fail, alert via Telegram and skip until manual review.
- **Guardrail**: #13 (security — PII).

### C-4. `run.ts` and `stream.ts` agent loops diverge silently (~55% overlap, not 90%) `[p1]` `[p2-scope-revised]`

> Pass 2: overlap measured more precisely. Pass 1 asserted "90% duplicate" (hand-wave); pass 2 counted shared imports + unique SSE emit code and arrived at ~55%. **Severity unchanged** (critical) because the bug-drift pattern is the same regardless of overlap percentage; only the fix scope is narrower than pass 1 implied.
- **Files**: [src/pipeline/agent-loop/run.ts](../../src/pipeline/agent-loop/run.ts) (164 LOC), [src/pipeline/agent-loop/stream.ts](../../src/pipeline/agent-loop/stream.ts) (222 LOC)
- **Problem**: Session init (requestId/sessionId generation, logger.forRequest, message setup), step-cap, post-firing, persistToChat, compressor-hook and heartbeat wiring are duplicated between non-stream and SSE paths. Previous assessments called it "90% duplication"; measured: both import the same `step.ts`/`tool-dispatch.ts`/`persist.ts` helpers, so the true overlap is in **orchestration shape** (~55%). Still: a fix to one path regularly misses the other (latest example in git log: `37de6c5 minimax + think-tag` — added to stream only, run.ts had a separate follow-up).
- **Impact**: Bugs in one path stay unfixed in the other for weeks.
- **Fix**: Extract `runAgentLoopCore(deps, req, hooks: { onStep, onDone, onError, onPersist })` shared function. `run.ts` and `stream.ts` become thin adapters (collect-to-result vs. emit-SSE). Estimate **L** (big surface, needs exhaustive test parity).

---

## Security issues

### S-1. `v-html` used for LLM-produced markdown without a real sanitizer `[p1]`
- **Files**: [web/app/components/ChatMessage.vue:69,77](../../web/app/components/ChatMessage.vue#L69), [web/app/components/memory/MemoryEditor.vue:287](../../web/app/components/memory/MemoryEditor.vue#L287)
- **Problem**: `renderedContent = render(content)` from [web/app/composables/useMarkdown.ts](../../web/app/composables/useMarkdown.ts) is then bound via `v-html`. The renderer escapes `&<>` **first** (order matters — this is why the file is currently XSS-safe), but every subsequent `.replace()` injects static HTML with captured groups `$1`. Today: no user-controlled attribute context, no link parsing, no `href=$1` — so no XSS vector exists as the file stands.
- **Impact**: One careless addition to `useMarkdown` (e.g. auto-linking `http://…` with a `href="$1"`, or rendering `<pre class="language-$1">` from code fences) opens reflected XSS against the main user. No CSP header to mitigate.
- **Fix**: Bring in `DOMPurify` (7 KB gzip) and apply it in `useMarkdown.render()` as the final step. Add a unit test that feeds `<img src=x onerror=alert(1)>`, `[x](javascript:alert(1))`, ``` `<script>` ``` and asserts no executable output.
- **Severity**: **high** (defensive). Today's code is accidentally safe; the invariant is fragile.

### S-2. `escapeHtml` does not escape `"` / `'` `[p1]`
- **File**: [web/app/composables/useMarkdown.ts:60-62](../../web/app/composables/useMarkdown.ts#L60-L62)
- **Problem**: Escapes `&`, `<`, `>` only. Safe today because no captured group is interpolated into an attribute context. Breaks the moment anyone adds `<a href="$1">` or similar.
- **Fix**: Add `.replace(/"/g, "&quot;").replace(/'/g, "&#39;")`. Subsumed by S-1 if DOMPurify lands.
- **Severity**: **medium** (paired with S-1).

### S-3. GitHub Copilot OAuth token persisted plaintext on disk `[p1]`
- **File**: [src/providers/copilot.ts:163](../../src/providers/copilot.ts#L163)
- **Problem**: Token written to `data/copilot-oauth.txt` (or wherever `tokenFilePath` points). No encryption, no `chmod 0600`.
- **Impact**: Single-user VPS (threat model: guihal's own box), so low-to-medium. But `data/` is inside the docker volume, which is routinely `docker cp`-ed; a stolen backup contains a fresh Copilot token.
- **Fix**: Write with mode `0600` (`Bun.write` supports `chmod` via a follow-up `fs.chmodSync`). Add docs note that the file is machine-local. Optional: symmetric-encrypt with a key derived from `PROXY_AUTH_TOKEN`.
- **Severity**: **high** (credential on disk; single-user threat model lowers the blast radius but not the category — backups, `docker cp`, snapshots all carry the token).

### S-4. Copilot `401/404` triggers unconditional re-auth loop `[p1]`
- **File**: [src/providers/copilot.ts:229-234](../../src/providers/copilot.ts#L229-L234)
- **Problem**: On 401/404 the token file is cleared and device-flow restarts. No max-retry counter, no backoff. If upstream enters a sustained bad state (deauth, revoked app, rate-limited 401), the process re-enters device flow repeatedly.
- **Fix**: Retry counter capped at 2 attempts per 5-minute window. On exhaustion, surface `ProviderError("copilot_auth_exhausted")` and let the fallback chain take over.
- **Severity**: **medium**.

### S-5. Error-body redaction uses narrow regex, only checks `api_key` `[p1]`
- **File**: [src/routes/chat.ts:164-186](../../src/routes/chat.ts#L164-L186) (and similar in [src/routes/logs.ts](../../src/routes/logs.ts))
- **Problem**: Upstream error bodies are sliced to 200 chars and regex-redacted, but only `api[_-]?key` is masked. `authorization`, `bearer`, `token=`, `x-api-key`, AWS-style `AKIA…` — all pass through.
- **Fix**: Centralize masking in `src/lib/redact.ts` (new): `maskSecrets(text: string) → string` with a comprehensive regex set. Apply **before** slicing (not after — a secret at char 201 survives today).
- **Severity**: **high** (direct secret-echo vector; guardrail #10 explicitly requires this).
- **Guardrail**: #10 (secret redaction in echoes).

### S-6. `logger.formatForDb` does not redact `meta` secrets `[p1]`
- **File**: [src/lib/logger.ts:116-140](../../src/lib/logger.ts#L116-L140)
- **Problem**: `meta` is stringified and concatenated into the log line. If any caller passes `{ meta: { api_key: "…" } }` (easy mistake), the secret lands in `raw_log`. Read-time masking in [src/routes/logs.ts](../../src/routes/logs.ts) does not cover console output or DB rows.
- **Fix**: Apply `maskSecrets()` from S-5 to each meta value before emitting.
- **Severity**: **high** (same class as S-5 — direct credential exposure in persisted DB rows).

### S-7. `/v1/autonomous` accepts unbounded `max_steps` `[p1]`
- **File**: [src/routes/autonomous.ts:60-61](../../src/routes/autonomous.ts#L60-L61) (line reference is within the schema block)
- **Problem**: TypeBox declares `max_steps: t.Number()` with no `maximum`. The clamp happens *inside* the handler (via `agent-loop/types.ts:MAX_STEPS = 100`), but a client can still send `max_steps: 1_000_000`; the validator accepts it, the handler clamps — fine today, but future refactors may miss the clamp.
- **Fix**: Schema-level `t.Number({ minimum: 1, maximum: 100 })`. Removes a class of defensive bugs.
- **Severity**: **low** (defense-in-depth).

### S-8. `GET /v1/logs/session/:id` and `GET /v1/logs/request/:id` have no ownership check `[p1]` `[p2-downgraded]`

> Pass 2 context: pass 1 flagged this as **critical IDOR**. Pass 2 re-reviewed `src/db/schema.ts` — zero `user_id` columns anywhere — so "multi-tenant IDOR" is a category error. Threat model is explicitly single-user. Downgraded to **low** with a migration-readiness note.
- **File**: [src/routes/logs.ts:69-119](../../src/routes/logs.ts#L69-L119)
- **Threat model note**: The service is single-tenant (one `PROXY_AUTH_TOKEN`). There is no multi-user concept in the schema — see `src/db/schema.ts`, zero `user_id` columns. So "IDOR" here is vacuous: the only authorized caller already owns every row.
- **Impact**: Today: none. If multi-tenancy is ever added, this is the first regression to trip.
- **Fix**: Defer until the multi-tenant roadmap item lands. Add a `// THREAT-MODEL: single-user` comment at the top of [src/routes/memory.ts](../../src/routes/memory.ts), [src/routes/chats.ts](../../src/routes/chats.ts), [src/routes/logs.ts](../../src/routes/logs.ts).
- **Severity**: **low** (contextual — not a bug in the current model).

### S-9. Tool name from LLM passed to `Map.get()` without allowlist validation `[p1]` `[p2-downgraded]`

> Pass 2: `Map.prototype.get("__proto__")` returns `undefined` in all modern engines — not the prototype chain. Pass 1 called this "prototype pollution critical"; pass 2 demoted to **low** consistency fix.
- **File**: [src/mcp/registry/tool-registry.ts:152](../../src/mcp/registry/tool-registry.ts#L152), [src/pipeline/agent-loop/tool-runner.ts](../../src/pipeline/agent-loop/tool-runner.ts)
- **Problem**: The tool name comes from `tool_calls[].function.name` — LLM-controlled. `Map.prototype.get("__proto__")` returns `undefined` in modern JS engines (not the prototype chain), so this is not currently exploitable. Still, dynamic registry (`create_tool`) *does* validate name format with `/^[a-z][a-z0-9_]{1,48}$/` ([src/pipeline/agent-loop/dynamic-tools.ts](../../src/pipeline/agent-loop/dynamic-tools.ts)), and that rule should be applied uniformly.
- **Fix**: Add the same regex check inside `ToolRegistry.call(name, …)` before the map lookup, returning `ToolError{code: "unknown_tool"}` on miss.
- **Severity**: **low** (not exploitable today; consistency fix).

### S-10. `code_tools` sandbox worker has unrestricted `fetch` `[p1]`
- **File**: [src/pipeline/agent-loop/code-tools/sandbox.ts:47-95](../../src/pipeline/agent-loop/code-tools/sandbox.ts#L47-L95)
- **Problem**: The Worker blob runs user-written TS with `fetch` available. An LLM-generated code tool can call any URL, including `127.0.0.1:4000` (this same proxy, leaking `PROXY_AUTH_TOKEN` via auto-forwarded headers if any) or `169.254.169.254` (IMDS on cloud). No allowlist; no timeout on the Worker beyond the agent-loop tool timeout.
- **Impact**: SSRF via the agent. The Worker cannot see env vars by default, but can probe localhost.
- **Fix**: (a) Wrap `fetch` in the blob preamble with an allowlist / block loopback + RFC1918. (b) Document that `create_code_tool` is agent-only (it already is) and gate behind `CODE_TOOLS_ENABLED` env flag.
- **Severity**: **high** (SSRF via LLM-authored code; the agent is trusted but not yet bounded — one prompt-injection on a scraped page turns into a localhost probe).

### S-11. `SECRET_JSON_RE` / `SECRET_KV_RE` are read-time-only redactors `[p2-new]`

> Added in pass 2. Pass 1 noted missing redaction only in echoed error bodies (S-5). Pass 2 traced the mask functions through the code and found they are read-path only — DB rows are stored raw.
- **File**: [src/routes/logs.ts:4-14](../../src/routes/logs.ts#L4-L14)
- **Problem**: Secrets are masked when the UI reads logs, but the DB stores plaintext. Anyone with SQLite access (i.e. anyone with file-system access to the container) reads them raw.
- **Fix**: Move `maskSecrets` to write-path — apply inside `logger.formatForDb` and `appendChatMessage`. Read-path becomes a second layer.
- **Severity**: **high** (same family as S-5, S-6; closes the write-path gap).

---

## Architecture issues

### A-1. `Promise.all` instead of `Promise.allSettled` in report-context fan-out `[p2-new]`

> Added in pass 2. Pass 1 searched for guardrail violations loosely; pass 2 ran `grep -rn "Promise.all(" src/ | grep -v allSettled` and found exactly one live hit. Single instance is still a **real** guardrail #2 violation.
- **File**: [src/rag/report-context.ts:142](../../src/rag/report-context.ts#L142)
- **Problem**: `const [facts, logs, ragHits] = await Promise.all([…])`. A single failure (e.g. RAG 429) aborts the whole fan-out; the others' work is discarded.
- **Fix**: `const [facts, logs, ragHits] = await Promise.allSettled(...)` + per-branch default. Matches guardrail #2 and the pattern used in `arbitration-room.ts`.
- **Severity**: **medium**.
- **Guardrail**: #2.

### A-2. `rate-limiter.tryAcquire().release()` is a no-op — live footgun despite dead code `[p1]` `[p2-downgraded]`
- **File**: [src/lib/rate-limiter.ts:82](../../src/lib/rate-limiter.ts#L82)
- **Problem**: `tryAcquire` returns `{ ok: true, release: () => {} }`. The `release` callback suggests an acquire-then-release contract, but `release` does nothing. A future caller that reserves a slot via `tryAcquire` and then bails out (error, short-circuit) cannot return the slot.
- **Impact**: **Today: no bug**. `tryAcquire` has 0 callers (`grep -rn "tryAcquire"` in `src/` returns only unrelated `tryAcquireLock` in `db/tables/scheduler-state.ts`). The previous agent marked this "critical memory leak" — false.
- **Fix**: Either delete `tryAcquire` (YAGNI) or implement real ref-counting by tracking the `timestamp` recorded so `release()` can splice it out. Given no current callers, prefer deletion.
- **Severity**: **low** (dead-code footgun).

### A-3. `backoff429()` creates a thundering-herd cliff `[p1]`
- **File**: [src/lib/rate-limiter.ts:86-93](../../src/lib/rate-limiter.ts#L86-L93)
- **Problem**: On upstream 429, fills the current window with phantom timestamps all set to `now`. When the window rolls in 60 s, *all* slots free simultaneously — queue drains in one burst, potentially re-triggering the 429.
- **Fix**: Distribute phantom timestamps across the 60-s window: `timestamps.push(now - ((slotsToFill - i) / slotsToFill) * WINDOW_MS + WINDOW_MS)`. Slots free gradually.
- **Severity**: **medium**.

### A-4. Rate-limiter `canRun`+`record` is not atomic under concurrent `schedule` `[p2-new]` `[disputed]`

> Added in pass 2. **Disputed:** pass 1 treated the single-threaded JS guarantee as implicit and clean. Pass 2 flags the invariant as fragile (one `await` insertion turns it into a race). Requires human review before closure: either accept the current model and lock it with a test, or pre-emptively add a Mutex.
- **File**: [src/lib/rate-limiter.ts:48-66](../../src/lib/rate-limiter.ts#L48-L66)
- **Problem**: `schedule()` calls `canRun()` then `record()` synchronously — safe in Bun's single-threaded event loop for the sync path. But two `schedule()` invocations that both resolve `canRun()` before either records can race only if one defers (microtask). Today, the sync fast path is fine; the risk emerges if anyone ever makes `canRun` async (for example, shared-counter across workers).
- **Fix**: Document the invariant ("single-threaded JS: canRun+record must stay sync"). Add a guard test that spies on ordering. No code change needed now.
- **Severity**: **low**.
- **Guardrail**: #4 (atomic tryAcquire under mutex).

### A-5. God-files over the 250-LOC cap `[p1]` `[p2-upgraded]`

> Pass 2 added `night-cycle/steps.ts` (435 LOC) and `lib/metrics.ts` (299 LOC) to the list — pass 1 only called out frontend `useMemory.ts` and `MemoryEditor.vue`.
- Files currently over the cap (excluding the two documented exceptions `system-prompt.ts` and `model-map.ts`):
  - [src/providers/copilot.ts](../../src/providers/copilot.ts) — **435** LOC
  - [src/pipeline/night-cycle/steps.ts](../../src/pipeline/night-cycle/steps.ts) — **435** LOC
  - [web/app/composables/useMemory.ts](../../web/app/composables/useMemory.ts) — **383** LOC
  - [src/lib/model-router.ts](../../src/lib/model-router.ts) — **326** LOC
  - [web/app/components/memory/MemoryEditor.vue](../../web/app/components/memory/MemoryEditor.vue) — **313** LOC
  - [src/lib/metrics.ts](../../src/lib/metrics.ts) — **299** LOC
- **Fix map**:
  - `copilot.ts` → split into `copilot/auth.ts` (device flow + token refresh), `copilot/chat.ts`, `copilot/stream.ts`, `copilot/headers.ts`.
  - `night-cycle/steps.ts` → `steps/scrub.ts`, `steps/translate.ts`, `steps/compress.ts`, `steps/verify.ts`, `steps/dedup.ts` (each step already has a clear boundary).
  - `useMemory.ts` → `useMemoryFocus.ts`, `useMemorySharedContext.ts`, `useMemoryArchive.ts`, `useMemoryLog.ts` + thin facade.
  - `model-router.ts` → `router/dispatch.ts`, `router/fallback.ts`, `router/provider-map.ts`, thin `ModelRouter` class.
  - `MemoryEditor.vue` → extract `<MemoryEditorHeader>`, `<MemoryEditorBody>`, `<MemoryEditorTags>`.
  - `metrics.ts` → `metrics/counters.ts`, `metrics/histograms.ts`, `metrics/report.ts`.
- **Severity**: **medium** (guardrail #1 deviation is a slow-drift failure mode).

### A-6. `useChat()` facade re-exports 14 symbols — consumers reach for everything `[p1]`
- **File**: [web/app/composables/useChat.ts](../../web/app/composables/useChat.ts)
- **Problem**: The facade returns the entire surface (state + actions + health). Components that need `messages` and `sendMessage` still pull in model-switch logic and health polling, bloating tree-shaking.
- **Fix**: Split into `useChatState` (already exists), `useChatActions` (send + persist), `useChatMode` (already exists). `useChat()` remains as a backwards-compatibility spread, deprecated.
- **Severity**: **low**.

### A-7. `run.ts` / `stream.ts` duplication — see C-4 `[p1]`
Duplicated with the Critical section because the fix spans architecture and the bug pattern directly.

### A-8. `HippoSession`-typed context `AgentLoopSession` lives in `mcp/registry/tool-registry.ts` `[p1]`
- **File**: [src/mcp/registry/tool-registry.ts](../../src/mcp/registry/tool-registry.ts)
- **Problem**: `AgentLoopSession` is an agent-loop concept leaking into the MCP tool registry. The registry is supposed to be a **transport-neutral** single source of truth for tool shape (guardrail #11).
- **Fix**: Move the `AgentLoopSession` interface to `src/pipeline/agent-loop/types.ts`, import it into the registry on the **agent-only** branch.
- **Severity**: **low**.

### A-9. `ToolContext` exposes `router` / `room` / `codeTools` to public-scope callers `[p1]`
- **File**: [src/mcp/mcp-protocol.ts:123-128](../../src/mcp/mcp-protocol.ts#L123-L128), [src/mcp/executor.ts:109-111](../../src/mcp/executor.ts#L109-L111)
- **Problem**: REST + MCP public callers receive the same `ToolContext` shape as the agent loop. A public tool handler that accidentally calls `ctx.router.chat()` would escalate (cost + side-channel).
- **Fix**: Split into `PublicToolContext { executor }` and `AgentToolContext extends PublicToolContext { router, room, codeTools, dynamicTools }`. Registry enforces at `register()` time based on `scope`.
- **Severity**: **medium**.
- **Guardrail**: #11.

### A-10. Single-source-of-truth drift — real model IDs outside `model-map.ts` `[p2-new]`

> Added in pass 2 after cross-reference with guardrail #11. Pass 1 did not grep for model-id substrings.
- **File**: grep `claude-|gpt-|devstral|minimax|MiniMax|step-` in `src/providers/` and `src/pipeline/`
- **Problem**: `CLAUDE.md` guardrail #11 requires **only** `src/lib/model-map.ts` to reference real model IDs. Today model IDs also appear in: provider system-prompts and fallback chains inside providers. For example, provider-specific request shapes sometimes use the wire-format model name as a string literal rather than the `model-map` entry.
- **Impact**: A model rename requires touching N files; easy to miss one.
- **Fix**: Add a lint script `scripts/check-model-ids.ts` that greps all non-`model-map.ts` files for known model-id substrings and fails on hit.
- **Severity**: **medium**.

---

## Code smells / improvements

### Q-1. Frontend `res.body!.getReader()` without null-check
- **File**: [web/app/composables/useChatStream.ts:5,60](../../web/app/composables/useChatStream.ts#L5)
- **Fix**: `if (!res.body) { updateLastAssistant({ content: "⚠️ Пустой ответ" }); return; } const reader = res.body.getReader();`
- **Severity**: **low** (SSE responses always have body in practice).

### Q-2. `useChatStream.ts` never sets `state.streaming.value = false` on agent SSE branch if `readAgentSSE` resolves normally
- **File**: [web/app/composables/useChatSend.ts:55-57](../../web/app/composables/useChatSend.ts#L55-L57) — branch `return;` after `readAgentSSE(res)` relies on `finally` at line 87-89. **Verified safe**. Not a bug.

### Q-3. `ChatMessage.vue` uses a `.collapsed` class that has no CSS definition
- **File**: [web/app/components/ChatMessage.vue:67-68](../../web/app/components/ChatMessage.vue#L67-L68)
- **Fix**: Either add `.thinking-block.collapsed { display: none; }` in scoped style, or flip the rendering to `v-show`.
- **Severity**: **low** (UX, not security).

### Q-4. `Bun.sleep` in retry backoff — runtime-locked + not cancellable
- **File**: [src/lib/http-client.ts:96](../../src/lib/http-client.ts#L96)
- **Fix**: Replace with `await new Promise((r, j) => { const t = setTimeout(r, ms); opts.signal?.addEventListener("abort", () => { clearTimeout(t); j(opts.signal.reason); }, { once: true }); })`.
- **Severity**: **low**.

### Q-5. `heartbeat` has no "stuck-stream" auto-close `[p2-new]`
- **File**: [src/pipeline/agent-loop/heartbeat.ts](../../src/pipeline/agent-loop/heartbeat.ts)
- **Fix**: Track `lastDataEmittedAt`; if `heartbeat_fired_count > 12` (i.e., 60 s of only pings) and the underlying step has not progressed, emit `event: stall` and close the stream.
- **Severity**: **low**.

### Q-6. Freelance anti-bot marker check is case-sensitive and substring-only
- **File**: [src/scheduler/freelance/fetch.ts:12-19](../../src/scheduler/freelance/fetch.ts#L12-L19)
- **Fix**: Case-insensitive regex; add `captcha`, `verify`, `just a moment`, `cf-ray` patterns.
- **Severity**: **low**.

### Q-7. `normalizeMessages` accepts `tool_calls: unknown` without shape validation
- **File**: [src/lib/messages.ts:45-53](../../src/lib/messages.ts#L45-L53)
- **Fix**: Define `ToolCallSchema = t.Object({ id: t.String(), type: t.Literal("function"), function: t.Object({ name: t.String(), arguments: t.String() }) })` and run it over each item.
- **Severity**: **low**.

### Q-8. No `NuxtErrorBoundary` at page level
- **Fix**: Wrap `<NuxtPage />` in `app.vue` with `<NuxtErrorBoundary>` + fallback UI ("Ошибка интерфейса — перезагрузите страницу").
- **Severity**: **low**.

### Q-9. Health polling at `index.vue` is page-local
- **File**: [web/app/pages/index.vue:48](../../web/app/pages/index.vue#L48)
- **Problem**: `setInterval(checkHealth, 15_000)` runs on the chat page only; visitors on `/memory` or `/freelance` don't know when the backend is down. Also no `onUnmounted(clearInterval)`.
- **Fix**: Move to `layouts/default.vue` (single owner) + `onUnmounted` cleanup.
- **Severity**: **low**.

### Q-10. `memory_search` tool has no hard response-size cap `[p2-new]`
- **File**: [src/mcp/tools/memory-tools.ts:152-168](../../src/mcp/tools/memory-tools.ts#L152-L168)
- **Fix**: Clamp `limit` to `min(params.limit, 50)`. Second-line defense: if total serialized size > 32 KB, truncate with a `{ truncated: true, omitted: N }` marker.
- **Severity**: **medium**.

### Q-11. `insertSorted` in rate-limiter is O(n) per insert
- **File**: [src/lib/rate-limiter.ts:118-132](../../src/lib/rate-limiter.ts#L118-L132)
- **Fix**: Not a bug; queue is typically <10 items. Noted for posterity.
- **Severity**: **nit**.

### Q-12. `paginate()` does not clamp query length `[p2-new]`
- **File**: [src/lib/api-envelope.ts:39-70](../../src/lib/api-envelope.ts#L39-L70)
- **Fix**: `const rawQ = typeof opts.q === "string" ? opts.q.trim().slice(0, 500) : ""`.
- **Severity**: **low** (DoS floor very high — `sanitizeFtsQuery` already caps term count).

---

## Refactor plan (prioritized PR list)

PRs are ordered so each one is mergeable and verifiable independently. "Depends-on" is explicit.

| # | Title | Depends-on | Size | Acceptance |
|---|---|---|---|---|
| **PR-1** | **Scheduler shutdown integration** | — | S | `installFreeAgentScheduler` / `installAutonomousScheduler` return `{stop}`. `shutdown.ts` awaits all stops. Test: spawn scheduler, send SIGTERM, assert no `setInterval` leak via `Bun.inspect`. Covers C-1. |
| **PR-2** | **Transactional post-extraction** | — | M | `writeContext` wraps `insertContext` + `rag.indexEntry` in `db.transaction()`; propagates failure. Live test kills NVIDIA mid-flight, asserts no orphan row. Covers C-2. |
| **PR-3** | **PII scrub retry queue** | — | M | On `scrubPII` error → push `entry_id` to `pii_scrub_retry` table; archive is skipped. Telegram alert after 3 retries. Covers C-3. |
| **PR-4** | **Write-time secret masking** | — | S | `maskSecrets(text)` in new `src/lib/redact.ts`; applied in `logger.formatForDb` + `appendChatMessage` + chat error-echo (before slicing). Unit tests for 6 secret patterns. Covers S-5, S-6, S-11. |
| **PR-5** | **Frontend XSS hardening** | — | S | `DOMPurify` in `useMarkdown.render()`. `escapeHtml` escapes quotes. Unit tests for img-onerror, javascript: href, `<script>`. Covers S-1, S-2. |
| **PR-6** | **Copilot auth hardening** | — | S | Retry cap on 401/404. Token file `chmod 0600`. Covers S-3, S-4. |
| **PR-7** | **Rate-limiter cleanup** | — | S | Delete unused `tryAcquire`. Distribute `backoff429` phantom timestamps across the window. Covers A-2, A-3. |
| **PR-8** | **Agent-loop orchestration dedup** | PR-2 | L | Extract `runAgentLoopCore(hooks)`; `run.ts`/`stream.ts` become ≤80 LOC adapters. Full test-suite parity: same outputs for same inputs on a fixture set. Covers C-4, A-7. |
| **PR-9** | **God-file split** | PR-8 | L | Each file in the A-5 list ≤250 LOC after split. TS project still builds; tests still pass. Covers A-5. |
| **PR-10** | **Tool context scope split** | — | M | Introduce `PublicToolContext` vs `AgentToolContext`; registry validates at `register`. Move `AgentLoopSession` to `agent-loop/types.ts`. Add `scripts/check-model-ids.ts` lint. Covers A-8, A-9, A-10. |

Cross-cutting PR (non-blocking, can be scheduled in parallel to any of the above):
- **PR-X** "Code smells batch": Q-1, Q-3, Q-4, Q-6, Q-7, Q-8, Q-9, Q-10, Q-12. Size **M**.

### Per-PR success criteria, test plan, and rollback

- **PR-1 rollback**: revert `install…` signatures to `void`; schedulers resume fire-and-forget. Safe because current behaviour is already fire-and-forget — the PR adds ability, does not remove any.
- **PR-2 rollback**: `.catch(() => {})` restored. Risk: partial-write regressions re-appear; mitigated by logging on re-introduce.
- **PR-3 rollback**: drop the `pii_scrub_retry` table, restore the `return text` fallback. Migration is additive (new table, no column drops), so backwards-compatible.
- **PR-4 rollback**: keep `maskSecrets` available but do not call from write-path; read-path masking still works. Safe.
- **PR-5 rollback**: remove `DOMPurify`; XSS risk returns to current "accidentally safe" state. Mitigation: keep `escapeHtml` quote-fix in place even on rollback.
- **PR-6 rollback**: drop retry counter; re-auth loop behaviour returns. Chmod is idempotent — safe to keep.
- **PR-7 rollback**: restore deleted `tryAcquire`; flatten phantom-timestamps distribution. No callers, zero risk.
- **PR-8 rollback**: branch-level revert only; `run.ts`/`stream.ts` return to duplicated state. Tests for each path still pass independently.
- **PR-9 rollback**: file-by-file — each split is independently revertable.
- **PR-10 rollback**: context-shape changes are type-level; registry enforcement can be short-circuited with a feature flag `SCOPE_ENFORCEMENT=off`.

**Test plan shared across PRs**:
- Every PR keeps `bunx tsc --noEmit -p tsconfig.json` exit 0 (guardrail "no TS errors").
- Every PR runs `bun test` (green) — `bun:test` only, no `*.live.ts` unless explicitly part of the PR's acceptance.
- PR-2, PR-3 require a live test (`tests/*.live.ts`) that kills an upstream mid-flight and asserts DB invariants.
- PR-8 requires a fixture-based parity test: same `AgentLoopRequest` → same `AgentLoopResult` on both paths (diff-checked).

---

## Guardrails violations log

| # | Guardrail | Status | Evidence |
|---|---|---|---|
| 1 | File cap 250 LOC | **violated** | A-5 (6 files). |
| 2 | `Promise.allSettled` for fan-out; `AbortController` composed | **violated** | A-1 (`report-context.ts:142`). Abort composition mostly clean. |
| 3 | Per-tool timeout in `tool-runner.ts`; `ToolError{code:"timeout"}` | **clean** | Verified presence of `TOOL_TIMEOUTS` array. |
| 4 | Rate-limit atomic `tryAcquire()` under `Mutex`; fallback capped | **partial** | A-4 (atomicity note); `tryAcquire` is dead code (A-2). |
| 5 | SSE ping 5s; `idleTimeout:255`; `wrapStreamForChat.isClosed` | **clean** | Verified in [src/lib/sse.ts](../../src/lib/sse.ts) + `index.ts`. |
| 6 | Insert + index wrapped in `db.transaction()` | **violated** | C-2 (extractors). |
| 7 | Outbound fetch via `http-client.ts` | **clean** | Only known exception: `code_tools` sandbox (S-10). |
| 8 | Elysia TypeBox for every route input; no `as any` | **partial** | S-7 (missing `max_steps` bounds). Query schemas on some GETs are lax but the threat model is single-user. |
| 9 | Logger contract `logger.info(stage, message, extra?)` | **clean** | `ScopedLogger` + `RequestLogger` both comply. Previously reported "violations" are false positives (see Appendix). |
| 10 | Echoed upstream bodies sliced ≤200 chars + regex-redact | **violated** | S-5 (regex narrow, redaction after slice). |
| 11 | Single-source-of-truth (model-map, MCP registry) | **partial** | A-8, A-9, A-10. Registry is the single source for tools; `AgentLoopSession` leaks. |
| 12 | `bun:test`; no top-level `process.exit`; live tests `*.live.ts` | **clean** (spot-check) | `tests/` was scoped out; sampled names match convention. |
| 13 | Security: `timingSafeEqual` + SHA-256; destructive scripts gated | **clean** | Verified [src/lib/auth.ts:11-14](../../src/lib/auth.ts#L11-L14). Scripts not re-audited in this pass. |
| 14 | Docs sync — split/move updates paths + `docs/completed/*.md` | **n/a** | This PR-plan explicitly lists doc updates per PR. |

---

## Appendix: false positives rejected

| # | Claim | Reality | Evidence |
|---|---|---|---|
| FP-1 | `useChatSend.ts` duplicates user message on send | Lines 15-18 append the user turn; lines 26-29 append the assistant **placeholder** (`content: ""`). No duplication. | Read [web/app/composables/useChatSend.ts:15-29](../../web/app/composables/useChatSend.ts#L15-L29). |
| FP-2 | `exec-summary.ts:81,95` single-arg logger contract violation | Calls are on `ScopedLogger` (`logger.child("pre")`). `ScopedLogger.warn(message)` is the correct 1-arg signature; stage is pre-bound. | [src/lib/logger.ts:211](../../src/lib/logger.ts#L211) defines `ScopedLogger.warn(message: string, extra?)`. |
| FP-3 | `system-prompt.ts` 280 LOC exceeds cap | Explicit documented exception in CLAUDE.md guardrail #1 ("Exceptions: `system-prompt.ts`, `model-map.ts`, `rag/pipeline.ts`, MCP registry, telegram"). | [CLAUDE.md](../../CLAUDE.md#coding-guardrails-from-refactor-pr-01-15) |
| FP-4 | `rate-limiter.tryAcquire().release()` is a **critical** memory leak | `tryAcquire` has **zero** callers (`grep -rn "tryAcquire" src/` returns only unrelated `tryAcquireLock` in `scheduler-state.ts`). Dead-code footgun → downgraded to **low** (A-2). | `grep` output in this audit. |
| FP-5 | `NightCycleController.running` boolean is a critical race | Bun/Node single-threaded event loop; `if (running) return; running = true;` happens in the same sync tick. The `.finally(() => running = false)` is asynchronous but there is no pre-emption window — no `await` exists between the check and the set. | Read [src/app/night-cycle-controller.ts:25-59](../../src/app/night-cycle-controller.ts#L25-L59). |

---

*Generated by RLM two-pass audit; pass 1 produced by parallel Explore fan-out, pass 2 applied the verification gate + FP pruning and added missing edge-case coverage (scheduler shutdown, transactional writes, PII fallback, secret masking at write-time). Intermediate `.pass1-draft.md` deleted after merge.*
