# A1 — Bun workspaces split (Kimi execution packets)

**Source spec:** `docs/specs/subbrain-main.md` § "Runtime Architecture Track
(Variant B, parallel to Phases)" → "A1 — Bun workspaces split" (lines 557-577).

**Goal of A1 (whole track):** purely mechanical move of `src/**` into
`packages/{core,providers,plugin,agent,server}/src/**`. One process, one Docker
image, one deploy. **Bit-for-bit equivalent runtime behavior.** Per-package
`package.json` (with `exports` map) + per-package `tsconfig.json`. Every change
is `git mv` + import path rewrite + manifest. No file content edits beyond that
(except the explicit shared-types pre-split in A1-2 and the explicit
`AppDeps`-cycle break in A1-7a).

**Risk tier (default):** `public-api` — import paths are part of the contract
surface for `scripts/`, `tests/`, future external SDK consumers, and existing
CLAUDE.md references. **Higher tiers per packet:** A1-3 is `schema+public-api`
(moves `src/db/schema.ts`, the FTS5 + sqlite-vec migration source).

## Decisions pre-resolved (so Kimi does not invent)

The spec target layout is non-exhaustive. The following decisions are
**locked** for this track. Kimi must not deviate; if a future packet appears to
contradict, `FAIL: spec-conflict` and stop.

| Question | Pre-decided answer |
|---|---|
| Where does `src/services/*` go? | `packages/agent/src/services/`. Importers live in `mcp/`, `pipeline/`, `app/`, `scheduler/`, plus thin uses by `routes/`. **Exception:** `src/services/auth.service.ts` moves to `packages/core/src/services/auth.service.ts` in A1-2 (cycle pre-split — `lib/auth.ts` middleware needs it; auth-service has zero non-stdlib imports). |
| Where does `src/app/*` go? | `packages/server/src/app/`. Bootstrap, deps wiring, schedulers, shutdown — these are entrypoint glue used only by `src/index.ts`. |
| Where do leftover `src/lib/*` files go (auth, clock, errors, memory-decay, metrics{.ts,/}, redact, sse)? | `packages/core/src/lib/`. They are infrastructure primitives reused by ≥2 packages. |
| Where do `src/providers/types.ts`, `src/rag/types.ts`, `src/pipeline/agent-loop/code-tools/types.ts` go? | `packages/core/src/types/{providers,rag,code-tool}.ts` — pre-split in A1-2 to break would-be cycles (`lib/messages.ts` needs `providers/types`; `lib/memory-decay.ts` needs `rag/types`; `db/tables/code-tools.ts` + `repositories/code-tools.repo.ts` need `code-tool/types`). The originals get re-exported from their old locations until A1-4/A1-5 move the implementations. |
| Where does `src/lib/personas/*` and `src/lib/personas.ts` go? | `packages/agent/src/personas/` (spec line 568 explicit). Both names coexist — `personas.ts` keeps that name; `personas/` directory keeps that name. Linux ext4 allows both; if a packet's filesystem rejects, halt with `FAIL: name-collision`. (`personas-root.ts` fallback removed — confirmed unnecessary on target FS.) |
| Where do `src/rag/*` and `src/telegram/*` go? | `packages/agent/src/rag/` and `packages/agent/src/telegram/`. They are integration logic the agent loop depends on; not part of HTTP transport. |
| Where do `src/mcp/transport.ts` and `src/mcp/mcp-protocol.ts` go? | `packages/server/src/mcp-transport/` (View-tier — they import Elysia and define HTTP/SSE routes per CLAUDE.md three-layer SoC). The rest of `src/mcp/` (registry, executor, tools, telegram-tools, snapshot, types, playwright-client, index) goes to `packages/agent/src/mcp/`. |
| Where does `src/scheduler/free-agent.ts` go? | `packages/agent/src/scheduler/free-agent.ts`. **Cycle break in A1-7a:** the `import type { AppDeps } from "../app/deps"` is replaced by a local `FreeAgentSchedulerDeps` interface (one structural type, agent-side); the `installFreeAgentScheduler(deps: FreeAgentSchedulerDeps)` signature stays compatible because `AppDeps extends FreeAgentSchedulerDeps` (server passes the wider type, agent only sees the narrow one). |
| Per-package name? | `@subbrain/core`, `@subbrain/providers`, `@subbrain/plugin`, `@subbrain/agent`, `@subbrain/server`. Private (`"private": true`), no publish. |
| Subpath exports? | Yes. Each package's `package.json#exports` map enumerates every consumed entrypoint as `"./<subpath>": "./src/<subpath>/index.ts"` (or `./src/<file>.ts`). Kimi MUST diff `git grep "from \"@subbrain/<pkg>"` after every packet and confirm every imported subpath is listed in `exports`. Missing subpath → `FAIL: missing-export`. |
| TS path alias? | None. Imports between packages use `@subbrain/<pkg>` or `@subbrain/<pkg>/<subpath>`. Bun workspaces resolve via `node_modules/@subbrain/<name>` symlinks. Inside a package use relative paths. The previous `@/*` → `./src/*` alias (0 hits) is dropped in A1-1. |
| `packages/plugin` content (types-only stub)? | `src/types.ts` placeholder + `src/index.ts` re-export. Placeholder shapes only — real Hooks land in A2. (Same content as previous draft.) |
| Are scripts/tests moved? | No. `scripts/` and `tests/` stay at repo root; their imports rewrite to `@subbrain/<pkg>` / `@subbrain/<pkg>/<subpath>` aliases. |
| Is `bun.lock` regenerated? | Yes, once per packet, via `bun install`. Commit it. |
| Are `tsbuildinfo` files committed? | No. Each per-package tsconfig sets `"composite": true` but `tsbuildinfo` is gitignored. Update `.gitignore` in A1-1. |
| Guardrail scripts? | `scripts/check-file-size.ts`, `check-deep-imports.ts`, `check-forbidden-patterns.ts` currently scan `src/`, `web/app/`, `scripts/` (+ `web/server` for forbidden). A1-1 extends `SCAN` to also include `packages/*/src` BEFORE any moves. Path keys in WHITELIST and TRANSITIONAL_DEEP_IMPORTS update per moving packet. |

## Packet ordering and dependency

Run sequentially. Each packet's acceptance must be green before the next
starts. Branch per packet, merge before the next.

```
A1-1   → workspace skeleton + extend guardrail SCAN to packages/*/src
A1-2   → packages/core: shared types pre-split + AuthService move
         (NEW prep packet — fixes the four core-import-cycles found by critic)
A1-3   → packages/core: db/, repositories/, lib/* implementations
         (was A1-2)
A1-4   → packages/providers
         (was A1-3)
A1-5   → packages/plugin (stub)
         (was A1-4)
A1-6a  → packages/agent: pipeline/ + services/ (split of old A1-5, part 1)
A1-6b  → packages/agent: mcp/ (registry+executor+tools — NOT transport)
A1-6c  → packages/agent: scheduler/ + telegram/
A1-6d  → packages/agent: rag/ + personas
A1-7   → packages/server: routes/, app/, mcp-transport/ (transport.ts + mcp-protocol.ts), src/index.ts
         (was A1-6)
A1-7a  → AppDeps cycle break (free-agent.ts → FreeAgentSchedulerDeps)
         (NEW micro-packet — depends on A1-6c structurally; runs immediately
          after A1-7 so the server-side `AppDeps` type is in its final home)
A1-8   → docker (was A1-7) — + workspace manifest COPY before bun install
A1-9   → cleanup + docs (was A1-8)
```

**Packet count: 13 (was 8).** Net delta +5: split old A1-5 (agent) into 4
sub-packets A1-6a/b/c/d for diff-budget realism; added A1-2 (shared-types
pre-split + AuthService) and A1-7a (AppDeps cycle break). A1-1 absorbs the
guardrail-scan-root extension. Old A1-2..A1-8 renumbered to A1-3..A1-9.

## Common acceptance commands (every packet)

```sh
bun install                                          # workspace symlinks fresh
bunx tsc --noEmit                                    # root tsc, exit 0
bun test                                             # exit 0, all passing
bun run scripts/check-deep-imports.ts                # exit 0
bun run scripts/check-file-size.ts                   # exit 0
bun run scripts/check-forbidden-patterns.ts          # exit 0
git status --porcelain | grep -v "^[ ?]" | wc -l     # tracked changes only
```

**Per-package tsc** (added per critic finding) — every packet that creates or
modifies a package runs:

```sh
bunx tsc -p packages/<pkg>/tsconfig.json --noEmit    # exit 0
```

(Listed in each packet's `acceptance` for the package(s) it touches.)

**Docker packets also run:**

```sh
docker compose build                                 # exit 0
```

(A1-8 lists `docker compose build` explicitly per critic finding.)

## Common non-goals (every packet)

1. No behavior change. The byte-for-byte content of any `.ts` file is
   unchanged except for `import` / `export` path strings, the explicit
   shared-types pre-split files in A1-2 (each contains only re-exports), the
   `FreeAgentSchedulerDeps` interface in A1-7a, and `package.json` /
   `tsconfig.json` files this packet creates.
2. No new public API. No new exports, no new modules, no new functions, no new
   types beyond the explicit `packages/plugin/src/types.ts` stub in A1-5 and
   the `FreeAgentSchedulerDeps` interface in A1-7a.
3. No file splits. The 150-line cap whitelist (`scripts/check-file-size.ts`)
   stays as-is in cap numbers; do not split or merge files even if a moved
   file flirts with the cap. Path keys update.
4. No file deletions outside `git mv` mechanics.
5. **Schema rule (A1-3 only):** `src/db/schema.ts` migration code, FTS5 setup,
   and `sqlite-vec` loader move byte-for-byte. The schema migration test
   (`tests/migrate.test.ts` or equivalent — the tests that open a fresh DB and
   call `migrate()`) MUST pass before and after A1-3. If a move appears to
   require schema content edits, `FAIL: spec-conflict-schema` and escalate.
6. No new dependencies in any `package.json` beyond what's already in root
   `package.json`. Per-package `dependencies` are subsets of the root list,
   declared so per-package `tsc --noEmit` can resolve them.
7. No CI / GitHub Actions / hook script edits. (`.github/`, `.husky/`,
   `scripts/install-hooks.sh` untouched.)

## Common escalation triggers (every packet)

- A `git mv` would require editing file contents beyond import paths or
  manifest creation → `FAIL: non-mechanical-edit-required`.
- `bunx tsc --noEmit` (root or per-package) reports an error not solvable by
  a path rewrite → `FAIL: type-error-non-mechanical`.
- A test file fails after move and the cause is not an import path → `FAIL:
  behavior-regression`.
- Two packages would need to import each other (cycle) → `FAIL:
  package-cycle <A>↔<B>`.
- Unable to resolve a package via `node_modules/@subbrain/<name>` after `bun
  install` → `FAIL: workspace-resolution`.
- A subpath used by an importer is not listed in the target package's
  `exports` map → `FAIL: missing-export`.
- `scripts/check-deep-imports.ts` flags a newly-introduced deep import →
  `FAIL: deep-import` (rules may need a tweak; flag, do not silently change).
- `scripts/check-file-size.ts` whitelist key path no longer matches after a
  move and the file is over cap → `FAIL: file-cap-conflict`.
- Diff exceeds `diff_budget_loc` → `FAIL: budget-exceeded`.

## Glossary

- **Mechanical move:** `git mv <old> <new>` plus `import` path string
  rewrites in dependents and the moved file itself. Zero content edits to
  function bodies, types, exports, or comments.
- **Workspace:** Bun's `package.json#workspaces` array (Bun 1.3 supports
  npm-style workspaces; verify via `bun pm ls`).
- **Package name:** scoped `@subbrain/<dir>` matching the directory under
  `packages/`. Internal-only (`"private": true`).
- **Subpath export:** entry in `packages/<pkg>/package.json#exports` mapping
  `"./<name>": "./src/<path>"` so `from "@subbrain/<pkg>/<name>"` resolves.
- **`AppDeps`:** the dependency container in `src/app/deps.ts`. Lives at
  `packages/server/src/app/deps.ts` after A1-7. Its shape is unchanged.
- **`FreeAgentSchedulerDeps`:** narrow agent-side type introduced in A1-7a.
  Structural subset of `AppDeps` containing exactly the fields
  `installFreeAgentScheduler` reads (`config.freeAgent`, `agentService`,
  `telegramBot?`). `AppDeps` is structurally assignable to it; the server
  passes its full `AppDeps` value at the call site without conversion.
- **Whitelist:** `scripts/check-file-size.ts` `WHITELIST` map. Per-file
  size override. A1 may not change cap numbers; only update path keys.

---

## Packet A1-1 — Workspace skeleton + guardrail scan roots

```json
{
  "task_id": "A1-1",
  "goal": "Configure Bun workspaces at repo root, create empty packages/ tree, and extend guardrail script scan roots to include packages/*/src before any source moves.",
  "non_goals": [
    "Do not move any file from src/ to packages/.",
    "Do not edit any .ts file under src/.",
    "Do not create any per-package package.json or tsconfig.json (those land in their own packets).",
    "Do not add new dependencies beyond what root package.json already lists.",
    "Do not delete the existing src/ directory or its contents.",
    "Do not change rule logic in guardrail scripts — only the SCAN array."
  ],
  "allowed_write_paths": [
    "package.json",
    "tsconfig.json",
    ".gitignore",
    "packages/.gitkeep",
    "scripts/check-file-size.ts",
    "scripts/check-deep-imports.ts",
    "scripts/check-forbidden-patterns.ts",
    "bun.lock"
  ],
  "read_context": [
    "package.json",
    "tsconfig.json",
    "scripts/check-file-size.ts",
    "scripts/check-deep-imports.ts",
    "scripts/check-forbidden-patterns.ts",
    "docs/tasks/runtime-arch/A1-workspaces-split.md",
    "docs/specs/subbrain-main.md:557-577"
  ],
  "risk_tier": "public-api",
  "acceptance": [
    "test -d packages",
    "test -f packages/.gitkeep",
    "node -e \"const p=require('./package.json'); if(!Array.isArray(p.workspaces)||!p.workspaces.includes('packages/*')||!p.workspaces.includes('web'))process.exit(1)\"",
    "grep -q 'packages/\\*/src' scripts/check-file-size.ts",
    "grep -q 'packages/\\*/src' scripts/check-deep-imports.ts",
    "grep -q 'packages/\\*/src' scripts/check-forbidden-patterns.ts",
    "bun install",
    "bunx tsc --noEmit",
    "bun test",
    "bun run scripts/check-deep-imports.ts",
    "bun run scripts/check-file-size.ts",
    "bun run scripts/check-forbidden-patterns.ts"
  ],
  "diff_budget_loc": 120,
  "file_count_max": 8,
  "rollback": "git checkout -- package.json tsconfig.json .gitignore bun.lock scripts/check-*.ts && rm -rf packages.",
  "escalation_triggers": [
    "Bun reports unknown 'workspaces' field — Bun version <1.1 → FAIL: bun-version.",
    "Existing scripts/check-*.ts has its SCAN array as a runtime-built value (not a literal) so a glob-style 'packages/*/src' cannot be added without rule-logic changes → FAIL: scan-array-not-literal (escalate; do NOT change rule logic).",
    "Existing scripts in package.json#scripts break under workspaces resolution → FAIL: scripts-broken."
  ],
  "glossary": {
    "workspaces array": "package.json#workspaces value [\"packages/*\", \"web\"]; Bun symlinks each workspace into node_modules during install.",
    "skeleton": "directory + .gitkeep only; no package manifests yet.",
    "scan roots": "the SCAN array literal at the top of each scripts/check-*.ts file. Adding 'packages/*/src' (or, if the script uses fs.readdirSync without glob expansion, an explicit walk over packages/*/src) makes guardrails see moved code."
  },
  "exact_steps": [
    "1. Add to root package.json (top-level, after 'private'): \"workspaces\": [\"packages/*\", \"web\"].",
    "2. In root tsconfig.json, remove the unused 'paths' map (verified 0 callsites of @/*). Leave 'include': [\"src/**/*.ts\"] AS IS — A1-1 does not move source. Leave 'exclude' as is.",
    "3. Append to .gitignore: '*.tsbuildinfo' (one line; check if already present, do not duplicate).",
    "4. Create directory packages/ with a single packages/.gitkeep file (empty).",
    "5. Extend SCAN in scripts/check-file-size.ts from `[\"src\", \"web/app\", \"scripts\"]` to `[\"src\", \"web/app\", \"scripts\"].concat(globPackagesSrc())` where globPackagesSrc returns `readdirSync('packages').filter(d=>statSync('packages/'+d).isDirectory() && existsSync('packages/'+d+'/src')).map(d=>'packages/'+d+'/src')`. Same edit shape in check-deep-imports.ts and check-forbidden-patterns.ts. With 0 packages today this returns []; subsequent packets get coverage automatically.",
    "6. Run `bun install` to refresh bun.lock with the workspaces field; commit the resulting bun.lock.",
    "7. Verify all acceptance commands pass."
  ]
}
```

---

## Packet A1-2 — Shared types pre-split + AuthService → packages/core (cycle break)

```json
{
  "task_id": "A1-2",
  "goal": "Pre-split the four shared type modules plus AuthService into packages/core before the bulk core move, leaving originals as one-line re-export shims for back-compat.",
  "non_goals": [
    "Do not move db/, repositories/, or any other lib/ file in this packet — those land in A1-3.",
    "Do not move providers/<other>.ts — only providers/types.ts.",
    "Do not move rag/<other>.ts — only rag/types.ts.",
    "Do not move pipeline/agent-loop/code-tools/<other>.ts — only types.ts.",
    "Do not edit src/services/auth.service.ts content beyond the new path.",
    "Do not delete the original-path shim files (they exist so unrewritten importers keep compiling); A1-3..A1-7 retire them as importers move.",
    "Do not introduce new symbols. Re-export surface = exact previous surface."
  ],
  "allowed_write_paths": [
    "packages/core/package.json",
    "packages/core/tsconfig.json",
    "packages/core/src/index.ts",
    "packages/core/src/types/providers.ts",
    "packages/core/src/types/rag.ts",
    "packages/core/src/types/code-tool.ts",
    "packages/core/src/services/auth.service.ts",
    "packages/core/src/lib/auth.ts",
    "src/providers/types.ts",
    "src/rag/types.ts",
    "src/pipeline/agent-loop/code-tools/types.ts",
    "src/services/auth.service.ts",
    "src/lib/auth.ts",
    "src/lib/messages.ts",
    "src/lib/memory-decay.ts",
    "src/db/tables/code-tools.ts",
    "src/repositories/code-tools.repo.ts",
    "scripts/check-file-size.ts",
    "scripts/check-deep-imports.ts",
    "bun.lock"
  ],
  "read_context": [
    "src/providers/types.ts",
    "src/rag/types.ts",
    "src/pipeline/agent-loop/code-tools/types.ts",
    "src/services/auth.service.ts",
    "src/lib/auth.ts",
    "src/lib/messages.ts",
    "src/lib/memory-decay.ts",
    "src/db/tables/code-tools.ts",
    "src/repositories/code-tools.repo.ts",
    "tests/auth-service.test.ts",
    "tests/auth.test.ts"
  ],
  "risk_tier": "public-api",
  "acceptance": [
    "test -f packages/core/package.json",
    "test -f packages/core/tsconfig.json",
    "test -f packages/core/src/index.ts",
    "test -f packages/core/src/types/providers.ts",
    "test -f packages/core/src/types/rag.ts",
    "test -f packages/core/src/types/code-tool.ts",
    "test -f packages/core/src/services/auth.service.ts",
    "test -f packages/core/src/lib/auth.ts",
    "test -f src/providers/types.ts && grep -q '@subbrain/core' src/providers/types.ts",
    "test -f src/rag/types.ts && grep -q '@subbrain/core' src/rag/types.ts",
    "test -f src/pipeline/agent-loop/code-tools/types.ts && grep -q '@subbrain/core' src/pipeline/agent-loop/code-tools/types.ts",
    "! test -f src/services/auth.service.ts",
    "! test -f src/lib/auth.ts",
    "bun install",
    "bunx tsc --noEmit",
    "bunx tsc -p packages/core/tsconfig.json --noEmit",
    "bun test",
    "bun test tests/auth-service.test.ts",
    "bun test tests/auth.test.ts",
    "bun run scripts/check-deep-imports.ts",
    "bun run scripts/check-file-size.ts",
    "bun run scripts/check-forbidden-patterns.ts"
  ],
  "diff_budget_loc": 200,
  "file_count_max": 25,
  "rollback": "git reset --hard HEAD~1 and bun install.",
  "escalation_triggers": [
    "AuthService imports anything from src/lib/* or src/db/* — currently it only imports node:crypto, but verify before move; if true, that import target must already live in core or this packet aborts → FAIL: auth-service-non-leaf.",
    "providers/types.ts, rag/types.ts, or code-tools/types.ts import from non-core sources — they must be type-only leaves; if not, listed in escalation log → FAIL: types-non-leaf.",
    "tsc reports unresolved @subbrain/core for any of the four pre-split modules — workspace symlink missing → FAIL: workspace-resolution.",
    "tests/auth-service.test.ts or tests/auth.test.ts fails after move (they import from src/services/auth.service — must rewrite to @subbrain/core) → FAIL: test-import-not-rewritten."
  ],
  "glossary": {
    "shim file": "the original-path file (e.g. src/providers/types.ts) replaced with `export * from \"@subbrain/core/types/providers\";` — keeps unrewritten importers compiling until A1-3..A1-7 finish rewriting them.",
    "leaf module": "imports only stdlib (node:*) or types from inside the same to-be-moved set — never anything from src/ that won't already be in core."
  },
  "exact_steps": [
    "1. Create packages/core/package.json: {\"name\":\"@subbrain/core\",\"private\":true,\"type\":\"module\",\"exports\":{\".\":\"./src/index.ts\",\"./types/providers\":\"./src/types/providers.ts\",\"./types/rag\":\"./src/types/rag.ts\",\"./types/code-tool\":\"./src/types/code-tool.ts\",\"./services/auth\":\"./src/services/auth.service.ts\",\"./lib/auth\":\"./src/lib/auth.ts\"}}.",
    "2. Create packages/core/tsconfig.json: {\"extends\":\"../../tsconfig.json\",\"compilerOptions\":{\"composite\":true,\"rootDir\":\"./src\",\"outDir\":\"./dist\"},\"include\":[\"src/**/*.ts\"]}.",
    "3. git mv src/providers/types.ts → packages/core/src/types/providers.ts. Then create a new src/providers/types.ts with content `export * from \"@subbrain/core/types/providers\";`.",
    "4. git mv src/rag/types.ts → packages/core/src/types/rag.ts. New shim src/rag/types.ts: `export * from \"@subbrain/core/types/rag\";`.",
    "5. git mv src/pipeline/agent-loop/code-tools/types.ts → packages/core/src/types/code-tool.ts. New shim src/pipeline/agent-loop/code-tools/types.ts: `export * from \"@subbrain/core/types/code-tool\";`.",
    "6. git mv src/services/auth.service.ts → packages/core/src/services/auth.service.ts. (No shim — only 4 importers, all rewritten this packet: src/lib/auth.ts, src/app/deps.ts, tests/auth-service.test.ts, tests/auth.test.ts, tests/auth-coverage.test.ts, tests/app-bootstrap.test.ts).",
    "7. git mv src/lib/auth.ts → packages/core/src/lib/auth.ts. Inside the moved file, rewrite `import type { AuthService } from \"../services/auth.service\";` → `import type { AuthService } from \"../services/auth.service\";` (path stays since both moved together — verify with grep).",
    "8. Update the 6 importers in step 6 to `from \"@subbrain/core/services/auth\"` (or `from \"@subbrain/core\"` once index.ts re-exports). Update src/app/deps.ts auth-middleware import to `from \"@subbrain/core/lib/auth\"`.",
    "9. Inside packages/core/src/types/providers.ts: verify it has zero non-stdlib imports. Same for rag.ts and code-tool.ts.",
    "10. Inside src/lib/messages.ts: rewrite `import type { Message } from \"../providers/types\";` → `import type { Message } from \"@subbrain/core/types/providers\";`.",
    "11. Inside src/lib/memory-decay.ts: rewrite `import type { RAGResult } from \"../rag/types\";` → `import type { RAGResult } from \"@subbrain/core/types/rag\";`.",
    "12. Inside src/db/tables/code-tools.ts and src/repositories/code-tools.repo.ts: rewrite their import of code-tools/types → `from \"@subbrain/core/types/code-tool\"`.",
    "13. Create packages/core/src/index.ts: `export * from \"./types/providers\"; export * from \"./types/rag\"; export * from \"./types/code-tool\"; export * from \"./services/auth.service\"; export * from \"./lib/auth\";` (matches the surface previously exposed at the moved leaf paths).",
    "14. Update scripts/check-file-size.ts WHITELIST keys: src/services/auth.service.ts (if listed) → packages/core/src/services/auth.service.ts; src/lib/auth.ts (if listed) → packages/core/src/lib/auth.ts. Update scripts/check-deep-imports.ts TRANSITIONAL_DEEP_IMPORTS likewise. Path edits only.",
    "15. Run `bun install`. Run all acceptance commands."
  ]
}
```

---

## Packet A1-3 — packages/core (db/, repositories/, lib/* implementations)

```json
{
  "task_id": "A1-3",
  "goal": "Move the rest of @subbrain/core (src/db/, src/repositories/, remaining src/lib/*) and retire A1-2 shims where importers have been rewritten.",
  "non_goals": [
    "Do not move src/lib/model-router*, src/lib/rate-limiter.ts, src/lib/personas* (those go to providers/agent in later packets).",
    "Do not edit function bodies, types, or comments inside any moved file.",
    "Do not split or merge any moved file.",
    "Do not change SQL strings, schema migration order, FTS5 setup, or sqlite-vec loader code.",
    "Do not introduce a barrel export that re-exports something not previously exposed at the same name.",
    "Do not retire the providers/types.ts, rag/types.ts, code-tool/types.ts shims yet — A1-4 retires providers/types shim, A1-6d retires rag/types shim, A1-6b retires code-tool/types shim."
  ],
  "allowed_write_paths": [
    "packages/core/package.json",
    "packages/core/src/**",
    "src/**",
    "scripts/**",
    "tests/**",
    "tsconfig.json",
    "scripts/check-deep-imports.ts",
    "scripts/check-file-size.ts",
    "bun.lock"
  ],
  "read_context": [
    "src/lib/logger.ts",
    "src/lib/http-client.ts",
    "src/lib/fts-utils.ts",
    "src/lib/api-envelope.ts",
    "src/lib/messages.ts",
    "src/lib/model-map.ts",
    "src/lib/model-map/openai-compat-overrides.ts",
    "src/lib/clock.ts",
    "src/lib/errors.ts",
    "src/lib/memory-decay.ts",
    "src/lib/metrics.ts",
    "src/lib/metrics/",
    "src/lib/redact.ts",
    "src/lib/sse.ts",
    "src/db/",
    "src/repositories/",
    "scripts/check-deep-imports.ts",
    "scripts/check-file-size.ts",
    "tests/migrate.test.ts"
  ],
  "risk_tier": "schema+public-api",
  "acceptance": [
    "test -d packages/core/src/db",
    "test -d packages/core/src/repositories",
    "test -d packages/core/src/lib",
    "test -f packages/core/src/lib/logger.ts",
    "test -f packages/core/src/lib/http-client.ts",
    "test -f packages/core/src/db/schema.ts",
    "test ! -e src/db",
    "test ! -e src/repositories",
    "test ! -e src/lib/logger.ts",
    "test ! -e src/lib/http-client.ts",
    "bun install",
    "bunx tsc --noEmit",
    "bunx tsc -p packages/core/tsconfig.json --noEmit",
    "bun test",
    "bun test tests/migrate.test.ts",
    "bun run scripts/check-deep-imports.ts",
    "bun run scripts/check-file-size.ts",
    "bun run scripts/check-forbidden-patterns.ts"
  ],
  "diff_budget_loc": 220,
  "file_count_max": 200,
  "rollback": "git reset --hard HEAD~1 and bun install.",
  "escalation_triggers": [
    "Any moved file in core imports something that lives in providers/, agent/, server/, or web/ — circular dependency → FAIL: package-cycle.",
    "tests/migrate.test.ts (or any test that opens a fresh DB and calls migrate()) fails after move → FAIL: spec-conflict-schema (escalate to strong; A1-3 risk tier was elevated for this).",
    "tsc reports a type error in a dependent that path-rewrite alone cannot fix → FAIL: type-error-non-mechanical.",
    "scripts/check-deep-imports.ts flags `@subbrain/core/src/...` style imports → FAIL: deep-import-rule-update.",
    "scripts/check-file-size.ts whitelist key path no longer matches after rename and the file is over cap → FAIL: file-cap-conflict.",
    "src/db/schema.ts requires content edits to compile under new path → FAIL: spec-conflict-schema.",
    "Moved core file content contradicts existing schema, repository, or service types → FAIL: spec contradicts code, list mismatch."
  ],
  "glossary": {
    "core (final shape after A1-3)": "@subbrain/core — pure primitives: logger, fetch wrapper, envelope helpers, error types, FTS sanitizer, model-map, DB facade + tables + schema, repositories, sse + metrics + clock + redact + memory-decay + messages-normalizer + auth (already moved in A1-2).",
    "diff_budget_note": "Bulk of diff is `git mv` directory moves (db/, repositories/, lib/*). Hand-written code stays under 250 LOC: package.json exports, tsconfig.json, index.ts barrel, import rewrites, guardrail path keys."
  },
  "exact_steps": [
    "1. Extend packages/core/package.json#exports with: \"./db\":\"./src/db/index.ts\", \"./repositories\":\"./src/repositories/index.ts\", \"./lib/logger\":\"./src/lib/logger.ts\", \"./lib/http-client\":\"./src/lib/http-client.ts\", \"./lib/fts-utils\":\"./src/lib/fts-utils.ts\", \"./lib/api-envelope\":\"./src/lib/api-envelope.ts\", \"./lib/messages\":\"./src/lib/messages.ts\", \"./lib/model-map\":\"./src/lib/model-map/index.ts\", \"./lib/clock\":\"./src/lib/clock.ts\", \"./lib/errors\":\"./src/lib/errors.ts\", \"./lib/memory-decay\":\"./src/lib/memory-decay.ts\", \"./lib/metrics\":\"./src/lib/metrics/index.ts\", \"./lib/redact\":\"./src/lib/redact.ts\", \"./lib/sse\":\"./src/lib/sse.ts\". (Keep the A1-2 entries.)",
    "2. git mv these into packages/core/src/ preserving structure: src/db/ → packages/core/src/db/. src/repositories/ → packages/core/src/repositories/.",
    "3. git mv src/lib/{logger,http-client,fts-utils,api-envelope,messages,clock,errors,memory-decay,redact,sse}.ts → packages/core/src/lib/. git mv src/lib/model-map.ts and src/lib/model-map/ subdirectory → packages/core/src/lib/model-map/<keep>. git mv src/lib/metrics.ts and src/lib/metrics/ → packages/core/src/lib/metrics/<keep>.",
    "4. Update packages/core/src/index.ts to also re-export the new modules (`export * from \"./db\"; export * from \"./repositories\"; export * from \"./lib/logger\";` etc.). Mirror exact set of exports previously importable from src/lib/<file> and src/db/index.ts and src/repositories/index.ts.",
    "5. Rewrite imports in all remaining files (src/, scripts/, tests/) that previously imported from these moved paths. Replacement rule: `from \"<rel>/lib/logger\"` → `from \"@subbrain/core/lib/logger\"` (or `from \"@subbrain/core\"` for top-level usage). Within packages/core itself, keep relative imports.",
    "6. Run `bun install` so workspace symlink @subbrain/core is fresh.",
    "7. Update root tsconfig.json: replace `\"include\": [\"src/**/*.ts\"]` with `\"include\": [\"src/**/*.ts\", \"packages/*/src/**/*.ts\"]` so root tsc still sees moved files until A1-9 narrows further.",
    "8. Update scripts/check-file-size.ts and scripts/check-deep-imports.ts whitelists/path keys: replace `src/db/` → `packages/core/src/db/`, `src/repositories/` → `packages/core/src/repositories/`, and the moved `src/lib/*.ts` paths → `packages/core/src/lib/*.ts`. Path edits only; do not change cap numbers or rules.",
    "9. Verify subpath-export coverage: `git grep \"from \\\"@subbrain/core/\" | sed -E 's|.*from \\\"(@subbrain/core[^\\\"]*)\\\".*|\\1|' | sort -u` — every entry must be either `@subbrain/core` or a key in the exports map.",
    "10. Run all acceptance commands; if any fails, classify against escalation triggers."
  ]
}
```

---

## Packet A1-4 — packages/providers

```json
{
  "task_id": "A1-4",
  "goal": "Move provider router and rate limiter into packages/providers; rewrite imports to @subbrain/providers; retire the src/providers/types.ts shim left by A1-2 (since src/providers/ is now empty).",
  "non_goals": [
    "Do not move anything outside src/providers/, src/lib/rate-limiter.ts, src/lib/model-router.ts, src/lib/model-router/.",
    "Do not edit any provider streaming logic, SSE parser, or fallback policy code beyond import strings.",
    "Do not adjust the model fallback chain in src/lib/model-map.ts (already in core).",
    "Do not change rate-limit numbers or backoff strategies.",
    "Do not introduce a new provider module."
  ],
  "allowed_write_paths": [
    "packages/providers/package.json",
    "packages/providers/tsconfig.json",
    "packages/providers/src/**",
    "src/**",
    "scripts/**",
    "tests/**",
    "scripts/check-deep-imports.ts",
    "scripts/check-file-size.ts",
    "bun.lock"
  ],
  "read_context": [
    "src/providers/",
    "src/lib/rate-limiter.ts",
    "src/lib/model-router.ts",
    "src/lib/model-router/",
    "packages/core/src/index.ts",
    "packages/core/package.json"
  ],
  "risk_tier": "public-api",
  "acceptance": [
    "test -f packages/providers/package.json",
    "test -f packages/providers/src/index.ts",
    "test -d packages/providers/src/providers",
    "test -f packages/providers/src/rate-limiter.ts",
    "test -f packages/providers/src/model-router.ts",
    "test -d packages/providers/src/model-router",
    "test ! -e src/providers",
    "test ! -e src/lib/rate-limiter.ts",
    "test ! -e src/lib/model-router.ts",
    "test ! -e src/lib/model-router",
    "bun install",
    "bunx tsc --noEmit",
    "bunx tsc -p packages/providers/tsconfig.json --noEmit",
    "bun test",
    "bun run scripts/check-deep-imports.ts",
    "bun run scripts/check-file-size.ts",
    "bun run scripts/check-forbidden-patterns.ts"
  ],
  "diff_budget_loc": 220,
  "file_count_max": 80,
  "rollback": "git reset --hard HEAD~1 and bun install.",
  "escalation_triggers": [
    "Any provider file imports from src/pipeline/, src/mcp/, src/scheduler/, or src/routes/ — would create cycle once agent/server are built; if found → FAIL: package-cycle.",
    "model-router imports model-map directly via relative path that crosses package boundary — must use @subbrain/core → FAIL: cross-pkg-relative-import.",
    "tsc reports unresolved @subbrain/core import inside packages/providers — workspace symlink missing → FAIL: workspace-resolution.",
    "src/providers/types.ts shim cannot be retired because some importer still uses the old path — list importers in fail message → FAIL: shim-still-used."
  ],
  "glossary": {
    "providers": "@subbrain/providers — provider HTTP clients, streaming, ModelRouter, RateLimiter. Depends only on @subbrain/core.",
    "diff_budget_note": "Bulk of diff is `git mv` directory moves (providers/, model-router/, rate-limiter.ts). Hand-written code stays under 250 LOC: package.json exports, tsconfig.json, index.ts barrel, import rewrites, guardrail path keys."
  },
  "exact_steps": [
    "1. Create packages/providers/package.json: {\"name\":\"@subbrain/providers\",\"private\":true,\"type\":\"module\",\"exports\":{\".\":\"./src/index.ts\",\"./providers\":\"./src/providers/index.ts\",\"./rate-limiter\":\"./src/rate-limiter.ts\",\"./model-router\":\"./src/model-router.ts\",\"./model-router/sse-parser\":\"./src/model-router/sse-parser.ts\"}} (extend the exports map to cover any subpath used by importers — verify with grep before writing).",
    "2. Create packages/providers/tsconfig.json extending root with composite + rootDir/outDir.",
    "3. git mv src/providers/ → packages/providers/src/providers/. git mv src/lib/rate-limiter.ts → packages/providers/src/rate-limiter.ts. git mv src/lib/model-router.ts → packages/providers/src/model-router.ts. git mv src/lib/model-router/ → packages/providers/src/model-router/.",
    "4. Retire the src/providers/types.ts shim from A1-2: since src/providers/ is now empty (the directory was moved), the shim was moved with it — verify it's now packages/providers/src/providers/types.ts and re-exports from @subbrain/core/types/providers. **Decision:** keep that shim alive (so downstream code that still imports `@subbrain/providers/types` resolves) by adding an export entry `\"./types\":\"./src/providers/types.ts\"`. Do NOT add a new top-level src/providers/types.ts at root — src/providers/ as a directory is gone.",
    "5. Create packages/providers/src/index.ts that re-exports the same surface as before (everything previously importable via `src/providers`, `src/lib/rate-limiter`, `src/lib/model-router`, `src/lib/model-router/<sub>`).",
    "6. Rewrite imports across remaining src/, scripts/, tests/ from old paths to `@subbrain/providers` (or its subpath). Inside packages/providers/, relative imports stay; cross-package references to logger/http-client/model-map → `@subbrain/core/...`.",
    "7. Run bun install. Verify subpath-export coverage with grep. Run all acceptance commands."
  ]
}
```

---

## Packet A1-5 — packages/plugin (types-only stub)

```json
{
  "task_id": "A1-5",
  "goal": "Create the placeholder packages/plugin types-only package with a minimum stub so future A2 work has a slot to land in.",
  "non_goals": [
    "Do not move any existing source file into packages/plugin.",
    "Do not implement any hooks pipeline, plugin loader, or runtime logic.",
    "Do not import packages/plugin from any other package yet.",
    "Do not add real Hooks shapes — placeholder type only.",
    "Do not edit anything outside packages/plugin/ and bun.lock."
  ],
  "allowed_write_paths": [
    "packages/plugin/package.json",
    "packages/plugin/tsconfig.json",
    "packages/plugin/src/index.ts",
    "packages/plugin/src/types.ts",
    "bun.lock"
  ],
  "read_context": [
    "docs/specs/subbrain-main.md:579-597",
    "packages/core/package.json"
  ],
  "risk_tier": "public-api",
  "acceptance": [
    "test -f packages/plugin/package.json",
    "test -f packages/plugin/src/types.ts",
    "test -f packages/plugin/src/index.ts",
    "bun install",
    "bunx tsc --noEmit",
    "bunx tsc -p packages/plugin/tsconfig.json --noEmit",
    "bun test",
    "bun run scripts/check-deep-imports.ts",
    "bun run scripts/check-file-size.ts",
    "bun run scripts/check-forbidden-patterns.ts"
  ],
  "diff_budget_loc": 80,
  "file_count_max": 4,
  "rollback": "rm -rf packages/plugin && git checkout -- bun.lock && bun install.",
  "escalation_triggers": [
    "tsc complains about composite project lacking input files → FAIL: tsc-composite-empty (verify include glob).",
    "Any other package gains a dependency on @subbrain/plugin during this packet → FAIL: out-of-scope-dep.",
    "Plugin stub type surface contradicts existing code-tool or sandbox types after A1-2 pre-split → FAIL: spec contradicts code, list mismatch."
  ],
  "glossary": {
    "stub": "minimum types so the package compiles and resolves; A2 replaces with real Hooks interface."
  },
  "exact_steps": [
    "1. Create packages/plugin/package.json: {\"name\":\"@subbrain/plugin\",\"private\":true,\"type\":\"module\",\"exports\":{\".\":\"./src/index.ts\",\"./types\":\"./src/types.ts\"}}.",
    "2. Create packages/plugin/tsconfig.json extending root with composite + rootDir/outDir.",
    "3. Create packages/plugin/src/types.ts with EXACTLY this content (placeholder; real shapes in A2):\n\nexport type ToolResult<T = unknown> =\n  | { ok: true; data: T }\n  | { ok: false; error: { code: string; message: string } };\n\nexport type ToolDefinition = {\n  name: string;\n  description: string;\n  scope: \"public\" | \"agent-only\";\n};\n\nexport type Hooks = Record<string, never>;\n\nexport function tool<T extends ToolDefinition>(def: T): T {\n  return def;\n}\n",
    "4. Create packages/plugin/src/index.ts: `export * from \"./types\";`.",
    "5. Run bun install. Run acceptance."
  ]
}
```

---

## Packet A1-6a — packages/agent: pipeline/ + services/

```json
{
  "task_id": "A1-6a",
  "goal": "Move src/pipeline/ and remaining src/services/ into packages/agent, establishing the package's manifest and barrel shape.",
  "non_goals": [
    "Do not move src/mcp/, src/scheduler/, src/rag/, src/telegram/, src/lib/personas* in this packet — those land in A1-6b/c/d.",
    "Do not split files. The 150-line cap whitelist stays untouched in cap numbers; only path keys update.",
    "Do not edit pipeline phase semantics, hippocampus step cap, arbitration weights, or context-compressor SOFT_LIMIT.",
    "Do not retire the code-tool/types shim from A1-2 — that retires in A1-6b once code-tools/ is also moved.",
    "Do not touch src/db/schema.ts (already in core) or any SQL."
  ],
  "allowed_write_paths": [
    "packages/agent/package.json",
    "packages/agent/tsconfig.json",
    "packages/agent/src/**",
    "src/**",
    "scripts/**",
    "tests/**",
    "scripts/check-deep-imports.ts",
    "scripts/check-file-size.ts",
    "bun.lock"
  ],
  "read_context": [
    "src/pipeline/",
    "src/services/",
    "packages/core/src/index.ts",
    "packages/providers/src/index.ts"
  ],
  "risk_tier": "public-api",
  "acceptance": [
    "test -d packages/agent/src/pipeline",
    "test -d packages/agent/src/services",
    "test ! -e src/pipeline",
    "test -z \"$(ls -A src/services 2>/dev/null)\" && rmdir src/services || true",
    "bun install",
    "bunx tsc --noEmit",
    "bunx tsc -p packages/agent/tsconfig.json --noEmit",
    "bun test",
    "bun run scripts/check-deep-imports.ts",
    "bun run scripts/check-file-size.ts",
    "bun run scripts/check-forbidden-patterns.ts"
  ],
  "diff_budget_loc": 220,
  "file_count_max": 200,
  "rollback": "git reset --hard HEAD~1 and bun install.",
  "escalation_triggers": [
    "Any pipeline or service file imports from src/routes/ or src/app/ — would create cycle once server is built → FAIL: package-cycle.",
    "tsc reports unresolved @subbrain/core or @subbrain/providers inside agent — workspace not linked → FAIL: workspace-resolution.",
    "A test file fails because of an order-of-import side effect (e.g. logger.child) → FAIL: side-effect-import."
  ],
  "glossary": {
    "agent (after A1-6a)": "@subbrain/agent — currently contains src/pipeline + src/services; A1-6b/c/d add mcp + scheduler + telegram + rag + personas.",
    "diff_budget_note": "Bulk of diff is `git mv` directory moves (pipeline/, services/). Hand-written code stays under 250 LOC: package.json exports, tsconfig.json, index.ts barrel, import rewrites, guardrail path keys."
  },
  "exact_steps": [
    "1. Create packages/agent/package.json: {\"name\":\"@subbrain/agent\",\"private\":true,\"type\":\"module\",\"exports\":{\".\":\"./src/index.ts\",\"./pipeline\":\"./src/pipeline/index.ts\",\"./services\":\"./src/services/index.ts\"}}. (Extend exports as A1-6b/c/d add subtrees.)",
    "2. Create packages/agent/tsconfig.json extending root with composite + rootDir/outDir.",
    "3. git mv src/pipeline/ → packages/agent/src/pipeline/.",
    "4. git mv src/services/* (everything except auth.service.ts which is already in core) → packages/agent/src/services/. src/services/ should now be empty — `rmdir src/services` if so.",
    "5. Create packages/agent/src/index.ts re-exporting whatever was previously importable from these subtrees (services/index.ts barrels, pipeline barrels). Mirror exact set of exports.",
    "6. Rewrite all remaining importers (src/, scripts/, tests/) from old paths → @subbrain/agent or @subbrain/agent/<subpath>. Within agent itself relative imports stay; cross-pkg references → @subbrain/core or @subbrain/providers.",
    "7. Update scripts/check-file-size.ts and scripts/check-deep-imports.ts path keys from src/{pipeline,services}/ → packages/agent/src/{pipeline,services}/.",
    "8. Verify subpath-export coverage. Run bun install. Run all acceptance commands."
  ]
}
```

---

## Packet A1-6b — packages/agent: mcp/ (registry + executor + tools, NOT transport)

```json
{
  "task_id": "A1-6b",
  "goal": "Move logic-tier MCP code into packages/agent/src/mcp/ and retire the A1-2 code-tool/types shim, leaving transport-tier files for A1-7.",
  "non_goals": [
    "Do not move src/mcp/transport.ts or src/mcp/mcp-protocol.ts — those are View-tier (Elysia routes) and belong in server in A1-7.",
    "Do not change tool registry semantics, tool scope assignments (public vs agent-only), or the dispatcher priority array.",
    "Do not split files."
  ],
  "allowed_write_paths": [
    "packages/agent/package.json",
    "packages/agent/src/mcp/**",
    "src/**",
    "scripts/**",
    "tests/**",
    "scripts/check-deep-imports.ts",
    "scripts/check-file-size.ts",
    "bun.lock"
  ],
  "read_context": [
    "src/mcp/",
    "packages/agent/src/index.ts"
  ],
  "risk_tier": "public-api",
  "acceptance": [
    "test -d packages/agent/src/mcp/registry",
    "test -d packages/agent/src/mcp/tools",
    "test -f packages/agent/src/mcp/snapshot.ts",
    "test -f packages/agent/src/mcp/telegram-tools.ts",
    "test -f packages/agent/src/mcp/types.ts",
    "test -f packages/agent/src/mcp/playwright-client.ts || true",
    "test -f src/mcp/transport.ts",
    "test -f src/mcp/mcp-protocol.ts",
    "ls src/mcp/ | wc -l | xargs -I {} test {} -le 3",
    "bun install",
    "bunx tsc --noEmit",
    "bunx tsc -p packages/agent/tsconfig.json --noEmit",
    "bun test",
    "bun run scripts/check-deep-imports.ts",
    "bun run scripts/check-file-size.ts",
    "bun run scripts/check-forbidden-patterns.ts"
  ],
  "diff_budget_loc": 180,
  "file_count_max": 80,
  "rollback": "git reset --hard HEAD~1 and bun install.",
  "escalation_triggers": [
    "Any moved mcp file imports Elysia or src/routes/ — should be logic-tier only; if found → FAIL: soc-violation.",
    "Transport files (transport.ts / mcp-protocol.ts) accidentally moved → FAIL: transport-misplaced.",
    "Code-tool/types shim cannot retire because some importer still uses src/pipeline/agent-loop/code-tools/types path → list importers → FAIL: shim-still-used."
  ],
  "glossary": {
    "logic-tier mcp": "registry/, executor/, tools/, snapshot.ts, telegram-tools.ts, types.ts, playwright-client.ts (if present), index.ts. NO Elysia imports.",
    "transport-tier mcp": "transport.ts (REST /mcp/tools/*) and mcp-protocol.ts (JSON-RPC SSE). Both import Elysia. Stay in src/ until A1-7.",
    "diff_budget_note": "Bulk of diff is `git mv` directory moves (mcp/registry/, mcp/executor/, mcp/tools/, snapshot.ts, etc.). Hand-written code stays under 200 LOC: package.json exports, index.ts barrel, import rewrites, guardrail path keys."
  },
  "exact_steps": [
    "1. Extend packages/agent/package.json#exports: \"./mcp\":\"./src/mcp/index.ts\", \"./mcp/registry\":\"./src/mcp/registry/index.ts\", \"./mcp/executor\":\"./src/mcp/executor/index.ts\", \"./mcp/tools\":\"./src/mcp/tools/index.ts\", \"./mcp/snapshot\":\"./src/mcp/snapshot.ts\", \"./mcp/telegram-tools\":\"./src/mcp/telegram-tools.ts\", \"./mcp/types\":\"./src/mcp/types.ts\", \"./mcp/playwright-client\":\"./src/mcp/playwright-client.ts\". (Verify each subpath is actually consumed via grep before adding.)",
    "2. git mv src/mcp/registry/ → packages/agent/src/mcp/registry/.",
    "3. git mv src/mcp/executor/ → packages/agent/src/mcp/executor/. (If executor is a single file src/mcp/executor.ts — git mv that file.)",
    "4. git mv src/mcp/tools/ → packages/agent/src/mcp/tools/.",
    "5. git mv src/mcp/snapshot.ts src/mcp/telegram-tools.ts src/mcp/types.ts src/mcp/index.ts → packages/agent/src/mcp/.",
    "6. If src/mcp/playwright-client.ts exists, git mv it too.",
    "7. Verify src/mcp/ now contains only transport.ts, mcp-protocol.ts (and maybe an empty index — leave as-is; A1-7 handles).",
    "8. Update packages/agent/src/index.ts to re-export from ./mcp where previous re-export existed.",
    "9. Retire src/pipeline/agent-loop/code-tools/types.ts shim left by A1-2: that file already lives at packages/agent/src/pipeline/agent-loop/code-tools/types.ts after A1-6a, but it's still a re-export shim pointing at @subbrain/core/types/code-tool. **Keep the shim alive** — agent-internal code can use `from \"./types\"` (relative) or the shim; cross-pkg use is `from \"@subbrain/core/types/code-tool\"`. Only remove the shim if zero importers reference it after rewrites.",
    "10. Rewrite all remaining importers from src/mcp/<logic-paths> to @subbrain/agent/mcp/<sub>.",
    "11. Update guardrail script path keys. Verify subpath-export coverage. Run all acceptance commands."
  ]
}
```

---

## Packet A1-6c — packages/agent: scheduler/ + telegram/

```json
{
  "task_id": "A1-6c",
  "goal": "Move src/scheduler/ and src/telegram/ into packages/agent, retaining free-agent.ts AppDeps import for A1-7a cycle break.",
  "non_goals": [
    "Do not edit free-agent.ts AppDeps import — that's the explicit cycle break in A1-7a.",
    "Do not change Telegram MTProto session handling, freelance scout playwright context isolation, or scheduler intervals.",
    "Do not split files."
  ],
  "allowed_write_paths": [
    "packages/agent/package.json",
    "packages/agent/src/scheduler/**",
    "packages/agent/src/telegram/**",
    "src/**",
    "scripts/**",
    "tests/**",
    "scripts/check-deep-imports.ts",
    "scripts/check-file-size.ts",
    "bun.lock"
  ],
  "read_context": [
    "src/scheduler/",
    "src/telegram/",
    "packages/agent/src/index.ts"
  ],
  "risk_tier": "public-api",
  "acceptance": [
    "test -d packages/agent/src/scheduler",
    "test -d packages/agent/src/telegram",
    "test -f packages/agent/src/scheduler/free-agent.ts",
    "test ! -e src/scheduler",
    "test ! -e src/telegram",
    "bun install",
    "bunx tsc --noEmit",
    "bunx tsc -p packages/agent/tsconfig.json --noEmit",
    "bun test",
    "bun run scripts/check-deep-imports.ts",
    "bun run scripts/check-file-size.ts",
    "bun run scripts/check-forbidden-patterns.ts"
  ],
  "diff_budget_loc": 180,
  "file_count_max": 50,
  "rollback": "git reset --hard HEAD~1 and bun install.",
  "escalation_triggers": [
    "free-agent.ts AppDeps import resolution: it imports `../app/deps` (relative to packages/agent/src/scheduler/) which now points to ../../../src/app/deps — still resolves because src/app/ has not moved yet. After A1-7 src/app moves to packages/server/src/app and the import would have to cross packages → cycle. **A1-6c MUST NOT edit this import.** A1-7a fixes it. → If tsc breaks at A1-6c because the relative path no longer resolves, FAIL: free-agent-import-broken-early (means src/app moved unexpectedly — investigate).",
    "Telegram bot tests fail (notify, polling) — likely import-path mismatch, not behavior; classify before failing."
  ],
  "glossary": {
    "scheduler (agent-side)": "autonomous, free-agent, freelance, telegram-poller, telegram-commands, telegram-bot/notify. Lifecycle managers; consumed by app/schedulers.ts (server-side) via type-only AppDeps signature.",
    "diff_budget_note": "Bulk of diff is `git mv` directory moves (scheduler/, telegram/). Hand-written code stays under 200 LOC: package.json exports, index.ts barrel, import rewrites, guardrail path keys."
  },
  "exact_steps": [
    "1. Extend packages/agent/package.json#exports: \"./scheduler\":\"./src/scheduler/index.ts\" (or per-file subpaths if no index), \"./telegram\":\"./src/telegram/index.ts\".",
    "2. git mv src/scheduler/ → packages/agent/src/scheduler/. git mv src/telegram/ → packages/agent/src/telegram/.",
    "3. Inside free-agent.ts: rewrite `import type { AppDeps } from \"../app/deps\"` to `import type { AppDeps } from \"../../../src/app/deps\"` ONLY IF the relative path no longer resolves after move. **Preferred: leave the import as `import type { AppDeps } from \"../app/deps\"` if Bun's workspace resolver can find src/app/deps via the still-existing src/ tree. Verify with `bunx tsc --noEmit`.** If it fails, halt with FAIL: free-agent-import-broken-early; A1-7 + A1-7a will resolve.",
    "4. Update packages/agent/src/index.ts to re-export scheduler + telegram surfaces.",
    "5. Rewrite all remaining importers from src/scheduler/<...>, src/telegram/<...> → @subbrain/agent/<sub>.",
    "6. Update guardrail path keys. Run all acceptance commands."
  ]
}
```

---

## Packet A1-6d — packages/agent: rag/ + personas

```json
{
  "task_id": "A1-6d",
  "goal": "Move src/rag/ and src/lib/personas* into packages/agent and retire the A1-2 src/rag/types.ts shim.",
  "non_goals": [
    "Do not change RAG retrieval scoring, FTS sanitizer use, persona prompt content.",
    "Do not split files.",
    "Do not retire the rag/types.ts shim if any importer still references it — verify with grep before deletion."
  ],
  "allowed_write_paths": [
    "packages/agent/package.json",
    "packages/agent/src/rag/**",
    "packages/agent/src/personas/**",
    "packages/agent/src/personas.ts",
    "src/**",
    "scripts/**",
    "tests/**",
    "scripts/check-deep-imports.ts",
    "scripts/check-file-size.ts",
    "bun.lock"
  ],
  "read_context": [
    "src/rag/",
    "src/lib/personas.ts",
    "src/lib/personas/",
    "packages/agent/src/index.ts"
  ],
  "risk_tier": "public-api",
  "acceptance": [
    "test -d packages/agent/src/rag",
    "test -d packages/agent/src/personas || test -f packages/agent/src/personas.ts",
    "test -f packages/agent/src/personas.ts",
    "test ! -e src/rag",
    "test ! -e src/lib/personas.ts",
    "test ! -e src/lib/personas",
    "bun install",
    "bunx tsc --noEmit",
    "bunx tsc -p packages/agent/tsconfig.json --noEmit",
    "bun test",
    "bun run scripts/check-deep-imports.ts",
    "bun run scripts/check-file-size.ts",
    "bun run scripts/check-forbidden-patterns.ts"
  ],
  "diff_budget_loc": 180,
  "file_count_max": 40,
  "rollback": "git reset --hard HEAD~1 and bun install.",
  "escalation_triggers": [
    "personas.ts and personas/ name collision rejected by FS — should not happen on Linux ext4 (target FS for prod + dev) → FAIL: name-collision (escalate).",
    "rag/types shim retire blocked by lingering importer — list importers → FAIL: shim-still-used."
  ],
  "glossary": {
    "personas coexistence": "src/lib/personas.ts and src/lib/personas/ already coexist on disk pre-A1. Linux ext4 supports this. After move, packages/agent/src/personas.ts and packages/agent/src/personas/ also coexist.",
    "diff_budget_note": "Bulk of diff is `git mv` directory moves (rag/, personas.ts, personas/). Hand-written code stays under 200 LOC: package.json exports, index.ts barrel, import rewrites, guardrail path keys."
  },
  "exact_steps": [
    "1. Extend packages/agent/package.json#exports: \"./rag\":\"./src/rag/index.ts\", \"./personas\":\"./src/personas.ts\". (If consumers import from `./personas/<sub>`, add those subpaths too.)",
    "2. git mv src/rag/ → packages/agent/src/rag/. After move, the rag/types.ts shim from A1-2 is at packages/agent/src/rag/types.ts. Decision: retire it — replace its body with the original type definitions (which were moved to packages/core/src/types/rag.ts in A1-2). **Wait — that would duplicate.** Correct decision: KEEP the shim at packages/agent/src/rag/types.ts as `export * from \"@subbrain/core/types/rag\";` so agent-internal relative imports `./types` keep working without forcing every callsite to know about the core path.",
    "3. git mv src/lib/personas.ts → packages/agent/src/personas.ts. git mv src/lib/personas/ → packages/agent/src/personas/. If FS rejects because of name collision (Linux ext4 does NOT reject; if mac/btrfs/zfs surprise), HALT with FAIL: name-collision.",
    "4. Update packages/agent/src/index.ts to re-export from ./rag and ./personas.",
    "5. Rewrite all remaining importers (src/, scripts/, tests/) from old paths → @subbrain/agent/<sub>.",
    "6. Verify src/lib/ has no leftover files — anything left should be a moved-but-not-deleted artifact; investigate.",
    "7. Update guardrail path keys. Run all acceptance commands."
  ]
}
```

---

## Packet A1-7 — packages/server (routes/, app/, mcp-transport/, src/index.ts)

```json
{
  "task_id": "A1-7",
  "goal": "Move HTTP routes, app bootstrap, src/mcp/transport.ts + mcp-protocol.ts, and src/index.ts into packages/server to finalize the empty src/ directory.",
  "non_goals": [
    "Do not change Elysia route shapes, validators, auth middleware, or response envelopes.",
    "Do not modify the SSE heartbeat interval or idleTimeout.",
    "Do not change the schedule installation order in app/schedulers.ts.",
    "Do not move scripts/ or tests/ into packages/server.",
    "Do not edit Dockerfile or docker-compose.yml — that lives in A1-8.",
    "Do not break the AppDeps cycle from free-agent.ts in this packet — that's A1-7a."
  ],
  "allowed_write_paths": [
    "packages/server/package.json",
    "packages/server/tsconfig.json",
    "packages/server/src/**",
    "package.json",
    "src/**",
    "scripts/**",
    "tests/**",
    "scripts/check-deep-imports.ts",
    "scripts/check-file-size.ts",
    "bun.lock"
  ],
  "read_context": [
    "src/index.ts",
    "src/app/",
    "src/routes/",
    "src/mcp/transport.ts",
    "src/mcp/mcp-protocol.ts",
    "packages/core/src/index.ts",
    "packages/providers/src/index.ts",
    "packages/agent/src/index.ts"
  ],
  "risk_tier": "public-api",
  "acceptance": [
    "test -f packages/server/package.json",
    "test -f packages/server/src/index.ts",
    "test -d packages/server/src/routes",
    "test -d packages/server/src/app",
    "test -d packages/server/src/mcp-transport",
    "test -f packages/server/src/mcp-transport/transport.ts",
    "test -f packages/server/src/mcp-transport/mcp-protocol.ts",
    "test ! -e src/routes",
    "test ! -e src/app",
    "test ! -e src/index.ts",
    "test ! -e src/mcp/transport.ts",
    "test ! -e src/mcp/mcp-protocol.ts",
    "ls src/mcp/ 2>/dev/null | wc -l | xargs -I {} test {} -eq 0 || true",
    "test -z \"$(ls -A src 2>/dev/null)\" && rmdir src || ls -la src",
    "node -e \"const p=require('./package.json'); if(p.module && p.module !== 'packages/server/src/index.ts') process.exit(1)\"",
    "bun install",
    "bunx tsc --noEmit",
    "bunx tsc -p packages/server/tsconfig.json --noEmit",
    "bun test",
    "bun run scripts/check-deep-imports.ts",
    "bun run scripts/check-file-size.ts",
    "bun run scripts/check-forbidden-patterns.ts"
  ],
  "diff_budget_loc": 220,
  "file_count_max": 100,
  "rollback": "git reset --hard HEAD~1 and bun install.",
  "escalation_triggers": [
    "src/ contains a file other than the moved set after the move (orphan) → FAIL: orphan-file.",
    "Root package.json#scripts entries reference src/index.ts; after rewrite to packages/server/src/index.ts, `bun run` fails → FAIL: scripts-broken.",
    "tsc reports unresolved @subbrain/agent or @subbrain/core import inside packages/server → FAIL: workspace-resolution.",
    "free-agent.ts AppDeps import breaks: this packet moves src/app/ → packages/server/src/app/, so the relative import from packages/agent/src/scheduler/free-agent.ts no longer resolves. Expected — A1-7a fixes it. **In A1-7 itself, accept that tsc may fail at this single import; mark it as known and let A1-7a green it.** If anything OTHER than free-agent.ts AppDeps fails, FAIL: unexpected-server-import-break."
  ],
  "glossary": {
    "server": "@subbrain/server — Elysia HTTP transport, route handlers, mcp-transport (REST + JSON-RPC SSE), app bootstrap, dependency wiring, scheduler installation entrypoints, src/index.ts entry.",
    "diff_budget_note": "Bulk of diff is `git mv` directory moves (routes/, app/, mcp-transport/, index.ts). Hand-written code stays under 250 LOC: package.json exports, tsconfig.json, index.ts barrel, import rewrites, root package.json module/scripts, guardrail path keys."
  },
  "exact_steps": [
    "1. Create packages/server/package.json: {\"name\":\"@subbrain/server\",\"private\":true,\"type\":\"module\",\"main\":\"./src/index.ts\",\"exports\":{\".\":\"./src/index.ts\",\"./app/deps\":\"./src/app/deps.ts\"}}. (`./app/deps` exported because A1-7a needs it as a stable reference point.)",
    "2. Create packages/server/tsconfig.json extending root with composite.",
    "3. git mv src/routes/ → packages/server/src/routes/. git mv src/app/ → packages/server/src/app/. git mv src/index.ts → packages/server/src/index.ts.",
    "4. mkdir packages/server/src/mcp-transport. git mv src/mcp/transport.ts → packages/server/src/mcp-transport/transport.ts. git mv src/mcp/mcp-protocol.ts → packages/server/src/mcp-transport/mcp-protocol.ts. After this, src/mcp/ should be empty — `rmdir src/mcp` if so.",
    "5. Verify src/ is now empty: `ls -A src` returns nothing → rmdir src.",
    "6. Update root package.json: change `module` from `index.ts` to `packages/server/src/index.ts`. Update any `package.json#scripts` entry referencing `src/index.ts` (`bun run src/index.ts`) → `bun run packages/server/src/index.ts`.",
    "7. Rewrite imports in moved files: cross-pkg → @subbrain/{core,providers,agent,plugin}. Within packages/server, relative imports stay.",
    "8. **Known broken import:** packages/agent/src/scheduler/free-agent.ts imports `../app/deps` which no longer resolves. **Do NOT fix in A1-7.** A1-7a is the explicit fix packet. tsc may report 1-2 errors at this exact import — they MUST be exactly that and nothing else. If other errors appear, escalate.",
    "9. Update scripts/check-file-size.ts and scripts/check-deep-imports.ts path keys for routes/, app/, index.ts, and mcp/{transport,mcp-protocol}.ts → mcp-transport/.",
    "10. bun install. Run all acceptance commands. **tsc may fail on the one free-agent.ts AppDeps import — accept and note.** Other acceptance must pass."
  ]
}
```

---

## Packet A1-7a — AppDeps cycle break (free-agent.ts → FreeAgentSchedulerDeps)

```json
{
  "task_id": "A1-7a",
  "goal": "Replace free-agent.ts agent→server AppDeps import with a local FreeAgentSchedulerDeps interface that AppDeps structurally satisfies.",
  "non_goals": [
    "Do not edit any other file beyond packages/agent/src/scheduler/free-agent.ts and the call site in packages/server/src/app/schedulers.ts.",
    "Do not introduce a new shared types package.",
    "Do not change runtime behavior (the function signature accepts a structural subset; AppDeps remains assignable).",
    "Do not export FreeAgentSchedulerDeps as a public agent API beyond what's needed for the import."
  ],
  "allowed_write_paths": [
    "packages/agent/src/scheduler/free-agent.ts",
    "packages/server/src/app/schedulers.ts"
  ],
  "read_context": [
    "packages/agent/src/scheduler/free-agent.ts",
    "packages/server/src/app/deps.ts",
    "packages/server/src/app/schedulers.ts"
  ],
  "risk_tier": "public-api",
  "acceptance": [
    "! grep -q '../app/deps' packages/agent/src/scheduler/free-agent.ts",
    "! grep -q '@subbrain/server' packages/agent/src/scheduler/free-agent.ts",
    "grep -q 'FreeAgentSchedulerDeps' packages/agent/src/scheduler/free-agent.ts",
    "bun install",
    "bunx tsc --noEmit",
    "bunx tsc -p packages/agent/tsconfig.json --noEmit",
    "bunx tsc -p packages/server/tsconfig.json --noEmit",
    "bun test",
    "bun run scripts/check-deep-imports.ts",
    "bun run scripts/check-file-size.ts",
    "bun run scripts/check-forbidden-patterns.ts"
  ],
  "diff_budget_loc": 60,
  "file_count_max": 2,
  "rollback": "git checkout -- packages/agent/src/scheduler/free-agent.ts packages/server/src/app/schedulers.ts.",
  "escalation_triggers": [
    "AppDeps cannot be structurally assigned to FreeAgentSchedulerDeps — means free-agent.ts uses a deps field not declared in the interface; widen the interface (still agent-side) → if widening would require pulling in agent-foreign types, FAIL: deps-shape-mismatch.",
    "Other tests fail (e.g. app-bootstrap.test.ts) because the call site signature changed — should not happen; AppDeps still assignable → FAIL: caller-signature-break."
  ],
  "glossary": {
    "FreeAgentSchedulerDeps": "agent-local interface containing exactly the fields free-agent.ts reads: { config: { freeAgent: { enabled: boolean; intervalMinutes: number; maxSteps: number; startupDelayMs: number; task: string } }, agentService: { run(input): Promise<{ stoppedReason: string; totalSteps: number; requestId: string; sessionId: string; finalAnswer?: string }> }, telegramBot?: { notify(msg: string): Promise<void> } }.",
    "structural assignability": "TypeScript treats two types as assignable if the target's required fields are present in the source. AppDeps has all FreeAgentSchedulerDeps fields plus more → AppDeps is assignable to FreeAgentSchedulerDeps without conversion."
  },
  "exact_steps": [
    "1. In packages/agent/src/scheduler/free-agent.ts, remove `import type { AppDeps } from \"../app/deps\";` (or whatever relative path it resolved to).",
    "2. Add a local interface declaration above installFreeAgentScheduler:\n\n```ts\nexport interface FreeAgentSchedulerDeps {\n  config: { freeAgent: { enabled: boolean; intervalMinutes: number; maxSteps: number; startupDelayMs: number; task: string } };\n  agentService: { run(input: { task: string; model: string; maxSteps: number; sessionId: string; priority: \"low\" | \"normal\" | \"high\"; agentMode: \"scheduled\" | \"interactive\"; agentId: string; schedule: { intervalMinutes: number; source: string } }): Promise<{ stoppedReason: string; totalSteps: number; requestId: string; sessionId: string; finalAnswer?: string }> };\n  telegramBot?: { notify(msg: string): Promise<void> };\n}\n```\n\n   **Verification:** before writing, read free-agent.ts top-to-bottom and enumerate every `deps.<field>` access. The interface must include exactly those — nothing more, nothing less. If a field is read that's not in the draft above, add it. If a field is in the draft but never read, remove it.",
    "3. Change the function signature: `installFreeAgentScheduler(deps: FreeAgentSchedulerDeps)`.",
    "4. In packages/server/src/app/schedulers.ts, the call `installFreeAgentScheduler(deps)` does NOT need a cast — AppDeps is structurally assignable. Verify by running tsc.",
    "5. Run all acceptance commands. Both per-package tsc invocations must be exit 0 (this is the cycle-break verification)."
  ]
}
```

---

## Packet A1-8 — Docker build update

```json
{
  "task_id": "A1-8",
  "goal": "Update Dockerfile and docker-compose.yml for multi-package layout, copying workspace manifests before bun install so the container boots from packages/server/src/index.ts.",
  "non_goals": [
    "Do not change the runtime image base (oven/bun:1.3-slim).",
    "Do not change Chrome / Playwright installation.",
    "Do not modify the named volume or any compose service besides build copy paths and CMD.",
    "Do not split the image into multiple containers (still one process, one image).",
    "Do not change EXPOSE port, healthcheck, env vars, or HEALTHCHECK command beyond endpoint URL parity."
  ],
  "allowed_write_paths": [
    "Dockerfile",
    "docker-compose.yml",
    ".dockerignore"
  ],
  "read_context": [
    "Dockerfile",
    "docker-compose.yml",
    "packages/server/src/index.ts",
    "packages/core/package.json",
    "packages/providers/package.json",
    "packages/plugin/package.json",
    "packages/agent/package.json",
    "packages/server/package.json",
    "package.json"
  ],
  "risk_tier": "public-api",
  "acceptance": [
    "docker compose build",
    "grep -q 'packages/' Dockerfile",
    "grep -q 'packages/server/src/index.ts' Dockerfile",
    "! grep -q 'COPY src/' Dockerfile",
    "grep -E 'COPY (packages/.*package\\.json|packages/\\*/package\\.json)' Dockerfile",
    "bunx tsc --noEmit",
    "bun test"
  ],
  "diff_budget_loc": 120,
  "file_count_max": 3,
  "rollback": "git checkout -- Dockerfile docker-compose.yml .dockerignore.",
  "escalation_triggers": [
    "docker compose build fails because bun install in container does not understand workspaces — likely Bun version pin issue → FAIL: bun-version-docker (Bun 1.3 supports workspaces, verify image tag).",
    "docker compose build fails with `lockfile mismatch` or `package.json missing` — workspace manifests not copied before install → FAIL: docker-manifest-copy-order (re-read step 2).",
    "Healthcheck fails after start because route path / port shifted → FAIL: behavior-regression (this packet must NOT shift any route).",
    "docker-compose web service build context (./web) breaks because workspaces bring web into root install → FAIL: web-build-conflict (likely needs `.dockerignore` tweak)."
  ],
  "glossary": {
    "manifest copy order": "with workspaces, `bun install --frozen-lockfile` resolves every workspace's package.json. They MUST exist in the build context before `bun install` runs. Copy them as a separate cache layer before the rest of source.",
    "build context": "subbrain service uses `build: .` — the Dockerfile receives the whole repo. Multi-package install happens once at build time.",
    "CMD target": "container entrypoint command; was `bun run src/index.ts`, becomes `bun run packages/server/src/index.ts`."
  },
  "exact_steps": [
    "1. In Dockerfile builder stage, BEFORE `bun install`, copy all package manifests so workspaces resolve. Replace the current single-line `COPY package.json bun.lock* ./` with:\n\n```\nCOPY package.json bun.lock* ./\nCOPY packages/core/package.json packages/core/\nCOPY packages/providers/package.json packages/providers/\nCOPY packages/plugin/package.json packages/plugin/\nCOPY packages/agent/package.json packages/agent/\nCOPY packages/server/package.json packages/server/\nCOPY web/package.json web/\n```\n\n   Then `RUN bun install --frozen-lockfile` runs against the populated workspaces tree.",
    "2. After `bun install`, replace `COPY src/ src/` with `COPY packages/ packages/`. Keep `COPY public/ public/`, `COPY scripts/ scripts/`, `COPY tsconfig.json ./`. Also COPY any per-package tsconfig.json — they're inside packages/<pkg>/ already so the `COPY packages/ packages/` step picks them up; verify.",
    "3. In Dockerfile runtime stage, replace `COPY --from=builder /app/src ./src` with `COPY --from=builder /app/packages ./packages`. Keep node_modules copy (workspace symlinks resolve since /app/packages is now in place). Also keep COPY of root package.json (already in Dockerfile).",
    "4. Replace CMD: `CMD [\"bun\", \"run\", \"src/index.ts\"]` → `CMD [\"bun\", \"run\", \"packages/server/src/index.ts\"]`.",
    "5. HEALTHCHECK URL was http://localhost:4000/health — unchanged. Leave HEALTHCHECK as is.",
    "6. Update .dockerignore (create if absent) to exclude: `**/dist`, `**/*.tsbuildinfo`, `node_modules`, `web/.nuxt`, `web/.output`, `data/`, `tmp/`. Verify `packages/` is NOT excluded.",
    "7. docker-compose.yml: no service-shape changes needed. The `subbrain` service still uses `build: .`. Verify `web` service still uses `build: ./web` and is not affected (web workspace is separate).",
    "8. Run `docker compose build` end-to-end (acceptance command #1). Confirm it succeeds. Do NOT run `up` in this packet."
  ]
}
```

---

## Packet A1-9 — Cleanup, doc paths, root tsconfig narrowing

```json
{
  "task_id": "A1-9",
  "goal": "Remove residual src/ references from CLAUDE.md, AGENTS.md, README.md, docs/, scripts/, narrow root tsconfig to packages/*, and retire leftover A1-2 shims with zero importers.",
  "non_goals": [
    "Do not introduce new doc content. Path rewrites only — `src/foo` → `packages/<pkg>/src/foo`.",
    "Do not edit substantive prose in CLAUDE.md / AGENTS.md beyond the path strings.",
    "Do not move tests or scripts into packages/.",
    "Do not touch docs/completed/* historical accuracy — those are point-in-time records.",
    "Do not delete any doc file."
  ],
  "allowed_write_paths": [
    "CLAUDE.md",
    "AGENTS.md",
    "README.md",
    "docs/**",
    "scripts/**",
    "tsconfig.json",
    "tests/**",
    "packages/**"
  ],
  "read_context": [
    "CLAUDE.md",
    "AGENTS.md",
    "README.md",
    "docs/specs/subbrain-main.md",
    "tsconfig.json",
    "scripts/check-deep-imports.ts",
    "scripts/check-file-size.ts",
    "scripts/check-forbidden-patterns.ts"
  ],
  "risk_tier": "public-api",
  "acceptance": [
    "! grep -rn 'src/services/' CLAUDE.md AGENTS.md README.md",
    "! grep -rn 'src/pipeline/' CLAUDE.md AGENTS.md README.md docs/tasks/runtime-arch/",
    "! grep -rn 'src/routes/' CLAUDE.md AGENTS.md README.md",
    "! grep -rn 'src/db/' CLAUDE.md AGENTS.md README.md",
    "node -e \"const t=require('./tsconfig.json'); if(t.include && t.include.some(p=>p.startsWith('src/'))) process.exit(1)\"",
    "bun install",
    "bunx tsc --noEmit",
    "bunx tsc -p packages/core/tsconfig.json --noEmit",
    "bunx tsc -p packages/providers/tsconfig.json --noEmit",
    "bunx tsc -p packages/plugin/tsconfig.json --noEmit",
    "bunx tsc -p packages/agent/tsconfig.json --noEmit",
    "bunx tsc -p packages/server/tsconfig.json --noEmit",
    "bun test",
    "bun run scripts/check-deep-imports.ts",
    "bun run scripts/check-file-size.ts",
    "bun run scripts/check-forbidden-patterns.ts"
  ],
  "diff_budget_loc": 220,
  "file_count_max": 40,
  "rollback": "git checkout -- CLAUDE.md AGENTS.md README.md docs tsconfig.json scripts && bun install.",
  "escalation_triggers": [
    "A doc path reference points to a file that does not exist under packages/ → FAIL: lost-file.",
    "Root tsconfig narrowing breaks `bunx tsc --noEmit` because some script under scripts/ relies on broader include → FAIL: tsc-include-too-narrow.",
    "Retiring a leftover A1-2 shim breaks an importer that was missed in A1-3..A1-7 → FAIL: shim-still-used (re-add the shim, list importer, escalate)."
  ],
  "glossary": {
    "current vs historical references": "Current = describes how the live code is laid out (rewrite). Historical = describes a past PR/audit/refactor outcome where the path is part of the record (leave). When uncertain, leave it.",
    "diff_budget_note": "Bulk of diff is doc path string rewrites (`src/foo` → `packages/<pkg>/src/foo`) across markdown files. Hand-written code stays under 250 LOC: tsconfig.json include narrowing, guardrail script path keys, shim retirement."
  },
  "exact_steps": [
    "1. Grep for `src/<dir>/` references across CLAUDE.md, AGENTS.md, README.md and docs/ (excluding docs/completed/*). Map each to packages/<pkg>/src/<dir>/ per the decision table at top of this file.",
    "2. Replace path strings only. Preserve surrounding prose.",
    "3. Update root tsconfig.json: change `\"include\": [\"src/**/*.ts\", \"packages/*/src/**/*.ts\"]` → `\"include\": [\"packages/*/src/**/*.ts\", \"scripts/**/*.ts\", \"tests/**/*.ts\"]`. Verify tsc still passes.",
    "4. Update scripts/check-deep-imports.ts, scripts/check-file-size.ts, scripts/check-forbidden-patterns.ts so any remaining literal `src/` path roots become `packages/<pkg>/src/`. Path-string rewrites only.",
    "5. Audit leftover A1-2 shims (packages/providers/src/providers/types.ts, packages/agent/src/rag/types.ts, packages/agent/src/pipeline/agent-loop/code-tools/types.ts). For each: `git grep \"@subbrain/<pkg>/<shim-path>\\|from .*\\\"\\.\\./<shim>\\\"\" packages/ scripts/ tests/`. If zero importers, delete the shim and remove its export from package.json. If importers remain, leave shim and document why.",
    "6. Run all acceptance commands including all 5 per-package tsc invocations."
  ]
}
```
