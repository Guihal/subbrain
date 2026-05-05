# Agent-teams plans for Kimi K2.6

> These plans decompose `docs/specs/subbrain-main.md` into bounded contracts
> for Kimi K2.6 workers in agent-teams mode.

## Operating Mode

Kimi K2.6 is useful here as a fast implementation worker, not as the final
architect.

Default team:

- Parent/teamlead: reads `docs/specs/subbrain-main.md`, assigns tasks, reviews
  merge boundaries.
- Kimi worker(s): implement exactly one contract file.
- Critic: reviews diff against the contract.
- Verifier: runs commands; executable checks win over model opinion.

## Worker Rules

Each Kimi worker must:

- read only the assigned contract plus directly referenced files;
- run pre-checks before editing;
- edit only allowed paths;
- avoid same-tool same-args retries after tool errors;
- stop on unclear architecture decisions;
- return `OK ...` or `FAIL: ...` exactly as the task says.

Hard bans for every worker:

- no `git reset --hard`;
- no `git checkout --`;
- no force push;
- no prod deploy;
- no `.env` reads;
- no broad refactors outside the contract;
- no `as any`;
- no raw `fetch` when `packages/core/src/lib/http-client.ts` is applicable;
- no `Promise.all` for fan-out; use `Promise.allSettled`.

## Suggested Waves

### Wave A — infrastructure side-car

- [01-bifrost-gateway.md](01-bifrost-gateway.md)

Run solo first. This touches the LLM path and should not happen in parallel
with other provider/router edits.

### Wave B — autonomous pool

- Existing detailed contracts:
  - `docs/tasks/refactor/39-prc1-agent-tasks-table.md`
  - `docs/tasks/refactor/40-prc2-pool-engine.md`
  - `docs/tasks/refactor/41-prc3-multi-runners.md`
  - `docs/tasks/refactor/42-prc4-parallel-concurrency.md`

Use them sequentially unless the parent explicitly rebases/splits them.

### Wave C — memory finalization

- [02-memory-bi-temporal.md](02-memory-bi-temporal.md)

Do after current memory-v2 tasks are reconciled with code.

### Wave D — structured output and evals

- [03-baml-promptfoo.md](03-baml-promptfoo.md)

Can run after Bifrost if prompts are stable.

### Wave E — observability

- [04-observability.md](04-observability.md)

Can run after Bifrost so traces include gateway calls.

### Wave F — A2A room

- [05-a2a-arbitration.md](05-a2a-arbitration.md)

Do after gateway + pool. This multiplies call paths and needs stable tracing.

## Parent Checklist Before Dispatch

1. Confirm `git status --short`.
2. Confirm no other worker owns overlapping write paths.
3. Paste exactly one contract into the worker.
4. Tell worker the branch/worktree policy.
5. After worker returns, inspect `git diff --name-only`.
6. Run contract acceptance commands locally.
7. Only then commit.
