# Phase 4 — BAML structured outputs + Promptfoo regression evals

**Status:** ACTIVE — Kimi execution packets
**Worker model:** Kimi K2.6 (kimi-claude direct path)
**Risk tier:** ordinary | public-api (no db, no security)
**Spec ref:** `docs/specs/subbrain-main.md` § Phase 4 (lines 475–488)

## Roadmap context

Phase 4 makes LLM I/O testable for four high-value structured outputs:

1. **Hippocampus extractor** — `packages/agent/packages/agent/packages/agent/packages/agent/src/pipeline/agent-pipeline/post/hippocampus.ts` + `extractors.ts` (write-path memory persistence after every exchange).
2. **Arbitration synthesis** — `packages/agent/packages/agent/packages/agent/src/pipeline/arbitration/synthesis.ts` + `prompts.ts` (teamlead synthesis of N specialist responses).
3. **Pool task artifact** — **PHASE 2 DEPENDENCY**, Phase 4 cannot migrate this until Phase 2 (`agent-pool` 39–42) lands the artifact contract. Packet P4-6 is deferred.
4. **Task extraction** — `packages/agent/packages/agent/packages/agent/src/mcp/tools/tasks-tools.ts` + `packages/agent/packages/agent/packages/agent/packages/agent/src/pipeline/agent-pipeline/post/extractors.ts` (`task_add` from hippocampus loop). Migration covered in P4-2 alongside hippocampus, since both share the post-extraction loop.

Non-goals (apply to every packet):

- No prompt UI.
- No full migration of every prompt — only the 4 listed.
- No replacement of `packages/core/packages/core/src/lib/model-map.ts` model selection.
- No removal of existing prompt path — BAML wraps the prompt and runs **alongside** original text-based call for one cycle (additive).
- No edits to `packages/agent/packages/agent/packages/agent/packages/agent/src/pipeline/agent-pipeline/post/hippocampus.ts` or `packages/agent/packages/agent/packages/agent/src/pipeline/arbitration/prompts.ts` / `synthesis.ts` in P4-2/P4-3 — BAML parsers are sibling helpers, original `tool_calls` parse and Russian-prose synthesis paths stay untouched.

## Packet decomposition

| ID | Goal | Risk | Depends on |
|---|---|---|---|
| P4-0 | Pin BAML CLI version in repo (resolve `<BAML_VERSION>` placeholder) | ordinary | — |
| P4-1 | Toolchain: install BAML CLI, init `baml_src/`, codegen wiring (ESM) | ordinary | P4-0 |
| P4-2 | Migrate hippocampus extractor + `task_add` shape to BAML types (sibling parser, additive) | public-api | P4-1 |
| P4-3 | Migrate arbitration synthesis output to BAML (fixture-only parser, no prompt edit) | public-api | P4-1 |
| P4-4 | Add Promptfoo config + 4 regression suites (custom JS provider, no fallback) | ordinary | P4-2, P4-3 |
| P4-5 | CI gate: `bun run promptfoo:ci` script + acceptance command | ordinary | P4-4 |
| P4-6 | DEFERRED — Pool artifact migration | public-api | **Phase 2 agent-pool 39–42** |

Total: **7 packets, 6 actionable + 1 deferred dependency-flag.**

---

## P4-0 — Pin BAML CLI version

```json
{
  "task_id": "P4-0",
  "goal": "Resolve the exact BAML CLI version to use in this repo and record it in package.json devDependencies as a literal pin (no caret, no tilde) so every subsequent packet installs the identical toolchain.",
  "non_goals": [
    "Do not run baml-cli init in this packet — only resolve and record the version.",
    "Do not create baml_src/ in this packet (P4-1 owns that).",
    "Do not edit any file under src/ in this packet.",
    "Do not add Promptfoo dependency (covered in P4-4)."
  ],
  "allowed_write_paths": [
    "package.json",
    "bun.lock"
  ],
  "read_context": [
    "package.json",
    "docs/specs/subbrain-main.md:475-488"
  ],
  "risk_tier": "ordinary",
  "acceptance": [
    "npm view @boundaryml/baml version",
    "bun add -d @boundaryml/baml@0.222.0",
    "grep -q '\"@boundaryml/baml\": \"0.222.0\"' package.json",
    "test ! -d baml_src",
    "bunx tsc --noEmit -p tsconfig.json",
    "bunx baml-cli --version"
  ],
  "diff_budget_loc": 30,
  "file_count_max": 2,
  "rollback": "Revert package.json + bun.lock to the previous commit.",
  "escalation_triggers": [
    "`npm view @boundaryml/baml version` returns a version newer than 0.222.0 — escalate; do not silently bump (other packets reference 0.222.0).",
    "`bunx baml-cli --version` reports a version that does not match 0.222.0 — escalate.",
    "Bun cannot install @boundaryml/baml@0.222.0 (registry/network) — stop, do not commit, escalate.",
    "BAML generated client or config contradicts existing TypeScript types in packages/agent/packages/agent/src/mcp/types.ts or packages/agent/src/pipeline/ — FAIL: spec contradicts code, list mismatch."
  ],
  "glossary": {
    "BAML": "Boundary's typed-prompt DSL — boundaryml/baml. Source files in baml_src/, codegen produces TypeScript clients.",
    "literal pin": "package.json devDependency value with no `^`/`~` prefix; exact version string only."
  },
  "implementation_notes": [
    "Verify `npm view @boundaryml/baml version` returns 0.222.0 (or newer; if newer, escalate per trigger above).",
    "Run `bun add -d @boundaryml/baml@0.222.0` exactly — no `^`/`~`.",
    "Confirm package.json shows `\"@boundaryml/baml\": \"0.222.0\"` with grep before finishing."
  ]
}
```

---

## P4-1 — BAML toolchain bootstrap (ESM)

```json
{
  "task_id": "P4-1",
  "goal": "Initialize baml_src/ with ESM-emitting generators.baml, wire bun-script baml:generate to produce src/baml_client/, and verify the generated client imports cleanly under the repo's ESM module system.",
  "non_goals": [
    "Do not migrate any prompt to BAML in this packet — only toolchain.",
    "Do not add Promptfoo dependency (covered in P4-4).",
    "Do not edit any file under packages/agent/src/pipeline/ in this packet.",
    "Do not touch packages/core/src/lib/model-map.ts.",
    "Do not bump or replace the @boundaryml/baml version pinned by P4-0."
  ],
  "allowed_write_paths": [
    "package.json",
    "baml_src/clients.baml",
    "baml_src/generators.baml",
    "tests/baml-esm-smoke.test.ts",
    ".gitignore"
  ],
  "read_context": [
    "package.json",
    "docs/specs/subbrain-main.md:475-488",
    "packages/core/src/lib/model-map.ts"
  ],
  "risk_tier": "ordinary",
  "acceptance": [
    "test -d baml_src && test -f baml_src/clients.baml && test -f baml_src/generators.baml",
    "grep -q 'module_format \"esm\"' baml_src/generators.baml",
    "bun run baml:generate",
    "test -d src/baml_client",
    "node -e \"import('./src/baml_client/index.js').then(m => { if (typeof m !== 'object') process.exit(1); })\"",
    "bun test tests/baml-esm-smoke.test.ts",
    "bunx tsc --noEmit -p tsconfig.json",
    "grep -q '\"baml:generate\"' package.json",
    "grep -q '^src/baml_client/' .gitignore"
  ],
  "diff_budget_loc": 220,
  "file_count_max": 5,
  "rollback": "Revert package.json scripts diff, delete baml_src/, src/baml_client/, tests/baml-esm-smoke.test.ts; restore .gitignore.",
  "escalation_triggers": [
    "`baml-cli generate` emits CommonJS despite `module_format \"esm\"` — escalate (do not hand-edit generated code).",
    "`import { ... } from './baml_client'` fails with `ERR_REQUIRE_ESM` or `Unknown file extension` — escalate (do not add a CJS shim).",
    "Generated src/baml_client/ collides with existing path — escalate.",
    "tsc fails on generated client — escalate (do not edit generated code).",
    "Generated baml_client code contradicts existing pipeline or tool types — FAIL: spec contradicts code, list mismatch."
  ],
  "glossary": {
    "ESM smoke test": "tests/baml-esm-smoke.test.ts: imports any generated symbol from `../src/baml_client` via static `import`, asserts `typeof <symbol> !== 'undefined'`. Verifies BAML output is `import`-able under repo's `\"type\": \"module\"`.",
    "baml:generate script": "package.json npm-script entry that runs `baml-cli generate`; outputs to src/baml_client/.",
    "module_format esm": "BAML generator option; emits .js with `import`/`export` syntax matching repo's `\"type\": \"module\"`. Without this, generator defaults to CJS (`require`/`module.exports`) which fails to load."
  },
  "implementation_notes": [
    "package.json scripts: add `\"baml:generate\": \"baml-cli generate\"`.",
    "baml_src/generators.baml content: `generator typescript { output_type \"typescript\" output_dir \"../src/baml_client\" module_format \"esm\" version \"0.222.0\" }`. The `module_format \"esm\"` line is mandatory — without it BAML emits CJS and import will fail under repo's `\"type\": \"module\"`.",
    "baml_src/clients.baml content: declare a single `client<llm> NimDefault { provider \"openai-generic\" options { base_url env.NIM_BASE_URL api_key env.NVIDIA_API_KEY model \"deepseek-ai/deepseek-v4-flash\" } }`. Real model selection still goes through packages/core/src/lib/model-map.ts at runtime — this client is only used by Promptfoo eval harness in P4-4, not by pipeline.",
    ".gitignore: append `src/baml_client/` (generated, regenerated on every `baml:generate`).",
    "tests/baml-esm-smoke.test.ts: `import { describe, test, expect } from 'bun:test'; import * as bamlClient from '../src/baml_client'; describe('baml-client esm', () => { test('imports as module', () => { expect(typeof bamlClient).toBe('object'); }); });`. This verifies static-import-under-ESM works, not just that tsc accepts the .d.ts."
  ]
}
```

---

## P4-2 — Hippocampus extractor BAML types (sibling parser)

```json
{
  "task_id": "P4-2",
  "goal": "Define BAML class shapes for HippocampusWrite (memory_write args) and TaskAdd (task_add args) and expose a sibling parser packages/agent/packages/agent/src/lib/structured-output/hippocampus.ts that validates raw tool_call args against those shapes; do not modify hippocampus.ts so the existing tool_calls parse at line ~214-215 stays the production path.",
  "non_goals": [
    "Do not edit packages/agent/packages/agent/packages/agent/src/pipeline/agent-pipeline/post/hippocampus.ts at all — the existing `tc.function.arguments` JSON.parse + parseMemoryWriteArgs path at line ~214-215 stays the production path.",
    "Do not change which model is used (POST_EXTRACTOR_MODEL env stays).",
    "Do not migrate arbitration in this packet (P4-3 owns that).",
    "Do not return BAML output via assistant `content` — the parser only validates an already-parsed tool-call args object; it never invokes BAML's prompt runtime to extract from `content` (that would change the upstream contract).",
    "Do not change the system prompt in packages/agent/packages/agent/packages/agent/src/pipeline/agent-pipeline/post/prompt.ts."
  ],
  "allowed_write_paths": [
    "baml_src/hippocampus.baml",
    "packages/agent/packages/agent/src/lib/structured-output/hippocampus.ts",
    "packages/agent/packages/agent/src/lib/structured-output/index.ts",
    "tests/structured-output-hippocampus.test.ts"
  ],
  "read_context": [
    "packages/agent/packages/agent/packages/agent/src/pipeline/agent-pipeline/post/hippocampus.ts:30-56",
    "packages/agent/packages/agent/packages/agent/src/pipeline/agent-pipeline/post/hippocampus.ts:186-228",
    "packages/agent/packages/agent/packages/agent/src/pipeline/agent-pipeline/post/extractors.ts:22-32",
    "packages/agent/packages/agent/packages/agent/src/pipeline/agent-pipeline/post/validators.ts",
    "packages/agent/packages/agent/packages/agent/src/pipeline/agent-pipeline/post/prompt.ts:25-77",
    "packages/agent/packages/agent/src/mcp/registry/tasks.tools.ts"
  ],
  "risk_tier": "public-api",
  "acceptance": [
    "bun run baml:generate",
    "bunx tsc --noEmit -p tsconfig.json",
    "bun test tests/structured-output-hippocampus.test.ts",
    "test -f packages/agent/packages/agent/src/lib/structured-output/hippocampus.ts",
    "test -f baml_src/hippocampus.baml",
    "git diff --name-only HEAD | grep -v 'packages/agent/packages/agent/packages/agent/src/pipeline/agent-pipeline/post/hippocampus.ts'"
  ],
  "diff_budget_loc": 280,
  "file_count_max": 4,
  "rollback": "Delete baml_src/hippocampus.baml + packages/agent/src/lib/structured-output/ + tests/structured-output-hippocampus.test.ts; rerun `bun run baml:generate`.",
  "escalation_triggers": [
    "BAML class definition for HippocampusWrite cannot represent the supersedes optional string[] field — escalate before guessing.",
    "packages/agent/packages/agent/src/lib/structured-output/hippocampus.ts grows >150 lines — split per file-size rule.",
    "Validator-vs-BAML semantic mismatch (e.g. shared category whitelist differs) — escalate, do not silently relax.",
    "Acceptance grep shows hippocampus.ts in diff — packet violated additive-only rule, revert and escalate.",
    "BAML HippocampusWrite shape contradicts existing extractor or memory types — FAIL: spec contradicts code, list mismatch."
  ],
  "glossary": {
    "HippocampusWrite": "BAML class { layer: \"shared\" | \"context\", category: string, content: string, tags: string, confidence: float, expires_at: int?, supersedes: string[]? } — direct typed mirror of memory_write tool_call args at hippocampus.ts:34-56.",
    "TaskAdd": "BAML class { title: string, description: string?, priority: \"low\" | \"normal\" | \"high\", due_at: int?, tags: string? } — mirror of task_add tool args.",
    "sibling parser": "Pure function `(raw: unknown) => { ok: true; value: T } | { ok: false; error: string }` in packages/agent/packages/agent/src/lib/structured-output/hippocampus.ts. Never throws. Mirrors parseMemoryWriteArgs semantics. Not invoked by hippocampus.ts in this packet — exists for Promptfoo (P4-4) and future opt-in callers.",
    "additive": "New files only; zero edits to packages/agent/packages/agent/packages/agent/src/pipeline/agent-pipeline/post/hippocampus.ts; production tool_calls dispatch path unchanged."
  },
  "implementation_notes": [
    "baml_src/hippocampus.baml: define `class HippocampusWrite { ... }` and `class TaskAdd { ... }`. No BAML `function` declarations needed (we use the types only, not BAML's prompt runtime, in this packet).",
    "packages/agent/packages/agent/src/lib/structured-output/hippocampus.ts exports `parseHippocampusWrite(raw: unknown): Result<HippocampusWrite>` and `parseTaskAdd(raw: unknown): Result<TaskAdd>`. Use the generated TS interfaces from src/baml_client as the type source; runtime check uses simple field validation matching the existing parseMemoryWriteArgs rules in hippocampus.ts:34-56.",
    "Input shape: parser receives the same `Record<string, unknown>` that hippocampus.ts builds via `JSON.parse(tc.function.arguments)` (line ~191). Do NOT accept a raw assistant-message `content` string and try to extract JSON from it — that's a different contract the upstream loop already rejected (`if (!msg.tool_calls)` branch nudges and bails).",
    "packages/agent/packages/agent/src/lib/structured-output/index.ts re-exports both parsers + a Result<T> = { ok: true; value: T } | { ok: false; error: string } type.",
    "tests/structured-output-hippocampus.test.ts: ≥3 happy cases per parser (valid shared write, valid context write with expires_at, valid task_add with priority='high'); ≥2 edge cases per parser (missing confidence, content over 600 chars for shared, invalid layer string)."
  ]
}
```

---

## P4-3 — Arbitration synthesis BAML output (fixture-only parser)

```json
{
  "task_id": "P4-3",
  "goal": "Define a BAML class ArbitrationSynthesis { synthesis: string, rationale: string, top_roles: string[] } and expose a fixture-only parser packages/agent/packages/agent/src/lib/structured-output/arbitration.ts that validates JSON-shaped input strings; do not modify prompts.ts or synthesis.ts so the production Russian-prose synthesis path stays untouched.",
  "non_goals": [
    "Do not change buildSynthesisSystemPrompt in packages/agent/packages/agent/src/pipeline/arbitration/prompts.ts — current Russian-prose template at lines 46-63 stays untouched (it does not produce fenced JSON, by design).",
    "Do not modify packages/agent/packages/agent/src/pipeline/arbitration/synthesis.ts — runSynthesis still returns Promise<string> and is not called by this parser at runtime.",
    "Do not migrate hippocampus in this packet (P4-2 owns that).",
    "Do not invoke parseArbitrationSynthesis from any production call site — parser is fixture-only (consumed by Promptfoo in P4-4 and future opt-in helpers, never by runSynthesis output)."
  ],
  "allowed_write_paths": [
    "baml_src/arbitration.baml",
    "packages/agent/packages/agent/src/lib/structured-output/arbitration.ts",
    "packages/agent/packages/agent/src/lib/structured-output/index.ts",
    "tests/structured-output-arbitration.test.ts"
  ],
  "read_context": [
    "packages/agent/packages/agent/src/pipeline/arbitration/synthesis.ts:80-104",
    "packages/agent/packages/agent/src/pipeline/arbitration/prompts.ts:46-63",
    "packages/agent/packages/agent/src/pipeline/arbitration/types.ts",
    "packages/agent/packages/agent/src/lib/structured-output/index.ts"
  ],
  "risk_tier": "public-api",
  "acceptance": [
    "bun run baml:generate",
    "bunx tsc --noEmit -p tsconfig.json",
    "bun test tests/structured-output-arbitration.test.ts",
    "test -f packages/agent/packages/agent/src/lib/structured-output/arbitration.ts",
    "test -f baml_src/arbitration.baml",
    "git diff --name-only HEAD | grep -v 'packages/agent/packages/agent/src/pipeline/arbitration/prompts.ts'",
    "git diff --name-only HEAD | grep -v 'packages/agent/packages/agent/src/pipeline/arbitration/synthesis.ts'"
  ],
  "diff_budget_loc": 220,
  "file_count_max": 4,
  "rollback": "Delete baml_src/arbitration.baml + packages/agent/packages/agent/src/lib/structured-output/arbitration.ts + tests/structured-output-arbitration.test.ts; revert packages/agent/packages/agent/src/lib/structured-output/index.ts re-export line.",
  "escalation_triggers": [
    "Caller in packages/agent/packages/agent/src/pipeline/arbitration/index.ts needs the metadata before P4-3 ships — escalate; do not change runSynthesis signature or wire the parser into production in this packet.",
    "BAML class cannot include a string[] for top_roles — escalate.",
    "packages/agent/packages/agent/src/lib/structured-output/arbitration.ts >150 lines — split.",
    "Acceptance grep shows prompts.ts or synthesis.ts in diff — packet violated fixture-only rule, revert and escalate.",
    "Tempted to add a structured-prompt helper that emits fenced JSON — DO NOT in this packet (separate, opt-in packet later); escalate.",
    "BAML arbitration metadata shape contradicts existing synthesis or room types — FAIL: spec contradicts code, list mismatch."
  ],
  "glossary": {
    "ArbitrationSynthesis": "BAML class { synthesis: string (final answer), rationale: string (why this synthesis), top_roles: string[] (which specialist roles dominated) }.",
    "fixture-only parser": "Function `parseArbitrationSynthesis(raw: string): Result<ArbitrationSynthesis>` consumed only by tests + Promptfoo fixtures. Never wired into runSynthesis or its callers in this packet — production teamlead synthesis stays Russian prose per prompts.ts:46-63.",
    "no-prompt-edit invariant": "buildSynthesisSystemPrompt at prompts.ts:46-63 produces Russian prose with consensus/divergence/weights instructions, NOT a fenced JSON block. The parser is built so a future opt-in structured-prompt helper can populate fixtures, but in this packet no such helper ships."
  },
  "implementation_notes": [
    "baml_src/arbitration.baml: declare `class ArbitrationSynthesis { synthesis string  rationale string  top_roles string[] }`.",
    "Parser strategy: search input string for a ```json ... ``` fenced block, JSON.parse, then field-validate against the BAML-generated TS interface. If no fence — return `{ ok: false, error: 'no json block' }`.",
    "tests/structured-output-arbitration.test.ts: ≥3 happy cases (single fenced block, fence with leading prose, top_roles with 1/2/3 entries); ≥2 edge cases (no fence at all, invalid JSON inside fence, missing top_roles field).",
    "packages/agent/packages/agent/src/lib/structured-output/index.ts: add `export { parseArbitrationSynthesis } from './arbitration'` line.",
    "Test fixtures must be hand-crafted JSON-fenced blocks; do NOT call buildSynthesisSystemPrompt or runSynthesis in tests (those still produce Russian prose, not JSON)."
  ]
}
```

---

## P4-4 — Promptfoo config + 4 regression suites (custom JS provider)

```json
{
  "task_id": "P4-4",
  "goal": "Add Promptfoo as devDependency, ship a custom JS provider (tests/prompts/providers/fixture-provider.js) that returns a fixture file's contents as the model output, and create promptfooconfig.yaml plus regression suites (hippocampus_write, task_add, arbitration_synthesis, pool_artifact_placeholder) under tests/prompts/ that pass `bunx promptfoo eval --no-cache` with no live LLM calls.",
  "non_goals": [
    "Do not require live API keys for `bunx promptfoo eval --no-cache` to pass — suites must run with the custom JS provider returning fixture file contents.",
    "Do not migrate any pipeline call site to use Promptfoo at runtime — Promptfoo is dev/CI only.",
    "Do not write to src/ in this packet (test infrastructure only).",
    "Do not exceed 6 files total.",
    "Do not use `provider: file://...fixture.json` directly — promptfoo's `file://` provider config expects a JS/Python provider module, not a JSON output. Use the custom JS provider in `allowed_write_paths`.",
    "Do not weaken the JS-provider assertion to `contains-json` regex on JS-provider failure — if JS provider errors, the suite must fail (no fallback chain)."
  ],
  "allowed_write_paths": [
    "package.json",
    "promptfooconfig.yaml",
    "tests/prompts/providers/fixture-provider.js",
    "tests/prompts/hippocampus.yaml",
    "tests/prompts/arbitration.yaml",
    "tests/prompts/fixtures/.gitkeep"
  ],
  "read_context": [
    "packages/agent/packages/agent/src/lib/structured-output/hippocampus.ts",
    "packages/agent/packages/agent/src/lib/structured-output/arbitration.ts",
    "packages/agent/packages/agent/packages/agent/src/pipeline/agent-pipeline/post/prompt.ts",
    "packages/agent/packages/agent/src/pipeline/arbitration/prompts.ts",
    "package.json"
  ],
  "risk_tier": "ordinary",
  "acceptance": [
    "bun add -d promptfoo@latest",
    "bunx promptfoo --version",
    "bunx promptfoo validate -c promptfooconfig.yaml",
    "test -f tests/prompts/providers/fixture-provider.js",
    "test -f tests/prompts/hippocampus.yaml",
    "test -f tests/prompts/arbitration.yaml",
    "grep -q 'hippocampus_write' tests/prompts/hippocampus.yaml",
    "grep -q 'task_add' tests/prompts/hippocampus.yaml",
    "grep -q 'arbitration_synthesis' tests/prompts/arbitration.yaml",
    "bunx promptfoo eval -c promptfooconfig.yaml --no-cache"
  ],
  "diff_budget_loc": 298,
  "file_count_max": 6,
  "rollback": "Revert package.json + bun.lock; delete promptfooconfig.yaml + tests/prompts/.",
  "escalation_triggers": [
    "Promptfoo `validate` rejects the custom JS provider entry — escalate; do not silently weaken to mocked output via `vars` overrides.",
    "Custom JS provider cannot read fixture file (path resolution / sandbox) — escalate; do not embed fixture content inline in YAML (defeats fixture-as-data purpose).",
    "JS-provider runtime error during `bunx promptfoo eval` — escalate; DO NOT add a `contains-json` fallback assertion that masks the provider failure.",
    "Pool artifact suite cannot be written because Phase 2 contract is missing — leave the file as a single-test placeholder with `description: BLOCKED ON PHASE 2` that asserts skip; do not invent the artifact shape.",
    "Promptfoo test assertions or provider contract contradicts existing BAML client or tool types — FAIL: spec contradicts code, list mismatch."
  ],
  "glossary": {
    "Promptfoo suite": "YAML file declaring `prompts`, `providers`, `tests` (each test is `vars` + `assert` list). https://promptfoo.dev/docs/configuration/guide/.",
    "custom JS provider": "Node.js module at tests/prompts/providers/fixture-provider.js exporting `class FixtureProvider { async callApi(prompt, context) { /* read context.vars.fixture_path, return { output: <file contents> } */ } }`. Referenced from promptfooconfig.yaml as `providers: - id: file://tests/prompts/providers/fixture-provider.js`. Promptfoo's `file://` provider syntax loads the JS module, not a JSON fixture directly — that was the misconception in the prior draft.",
    "fixture file": "Plain `.json` or `.txt` under tests/prompts/fixtures/ containing the exact string the model would have returned. Loaded by FixtureProvider via `vars.fixture_path` per test case.",
    "golden case": "Test entry with `vars.fixture_path` pointing at a happy-path fixture and `assert` list that fixes the expected JSON shape using the parser from src/lib/structured-output.",
    "edge case": "Test entry pointing at a fixture with empty/invalid/oversized content (missing confidence, content >600 chars, no JSON fence) where the parser is expected to return `{ ok: false }` — the JS-assert flips that into a positive expectation."
  },
  "implementation_notes": [
    "tests/prompts/providers/fixture-provider.js: ESM module (repo is `\"type\": \"module\"`), exports `default class { async callApi(_prompt, ctx) { const fs = await import('node:fs/promises'); const path = ctx.vars.fixture_path; const output = await fs.readFile(path, 'utf8'); return { output }; } }`. Provider id in YAML: `file://tests/prompts/providers/fixture-provider.js`.",
    "promptfooconfig.yaml: top-level `description`, `prompts: ['file://tests/prompts/*.yaml']`, default `providers: [ { id: 'file://tests/prompts/providers/fixture-provider.js' } ]`. No real API.",
    "tests/prompts/hippocampus.yaml: 2 sub-suites — `hippocampus_write` and `task_add`. Each ≥3 golden cases (valid shared write of category=preference, valid context write with expires_at, valid task_add with priority=normal) + ≥2 edge cases (missing confidence → expect parse failure; content over cap → expect parse failure). Each test sets `vars.fixture_path` pointing at a fixture under tests/prompts/fixtures/ (created at test-setup time or committed as data; the .gitkeep keeps the dir tracked even if fixtures are generated).",
    "tests/prompts/arbitration.yaml: 1 sub-suite `arbitration_synthesis` with ≥3 golden cases (single fenced block, fence with prose around, top_roles with 3 entries) + ≥2 edge cases (no fence, invalid JSON in fence). Plus `pool_artifact_placeholder` sub-suite with a single skipped test that documents Phase 2 dependency.",
    "Assertions: each test uses ONE `assert` of `type: javascript` calling the relevant parser from src/lib/structured-output (import via dynamic `await import('../../packages/agent/src/lib/structured-output/index.js')` inside the inline JS assertion). DO NOT add a fallback `contains-json` + regex chain on top — if the JS assertion fails or throws, the test must fail loudly (escalation trigger), not be rescued by a weaker check.",
    "Fixtures: minimum committed set under tests/prompts/fixtures/ to make `bunx promptfoo eval --no-cache` deterministic; no network, no LLM."
  ]
}
```

---

## P4-5 — CI gate `promptfoo:ci`

```json
{
  "task_id": "P4-5",
  "goal": "Add a single package.json script `promptfoo:ci` that runs `promptfoo eval -c promptfooconfig.yaml --no-cache` and exits non-zero on any failed assertion, plus extend the existing `bun run rails` chain to include it as the last step.",
  "non_goals": [
    "Do not add a GitHub Actions workflow file — repo currently has no .github/workflows path under management; CI integration here is a local npm-script gate only.",
    "Do not migrate any pipeline code in this packet.",
    "Do not change baml:generate, lint, typecheck, or guardrails commands.",
    "Do not require live API keys for the script to succeed."
  ],
  "allowed_write_paths": [
    "package.json"
  ],
  "read_context": [
    "package.json",
    "promptfooconfig.yaml",
    "tests/prompts/hippocampus.yaml",
    "tests/prompts/arbitration.yaml"
  ],
  "risk_tier": "ordinary",
  "acceptance": [
    "grep -q '\"promptfoo:ci\"' package.json",
    "bun run promptfoo:ci",
    "bun run rails"
  ],
  "diff_budget_loc": 30,
  "file_count_max": 1,
  "rollback": "Revert package.json scripts diff.",
  "escalation_triggers": [
    "promptfoo eval requires a provider API key even for the custom JS provider — escalate; do not commit a stub key.",
    "rails chain becomes >5min on cold cache — escalate (consider gating promptfoo:ci to a separate `rails:full` only).",
    "`bun run rails` exits non-zero after the change but `bun run promptfoo:ci` alone passes — escalate (regression in another rails step, do not silently drop promptfoo:ci).",
    "promptfoo config or provider contradicts existing BAML client or tool types — FAIL: spec contradicts code, list mismatch."
  ],
  "glossary": {
    "rails chain": "package.json script `rails` = guardrails && lint && typecheck. Extended here to append `&& bun run promptfoo:ci` as the final gate. `bun run rails` exit code propagates through `&&` natively — exit code of the chain is what we rely on (no `echo $? | grep` post-check, that idiom is a no-op).",
    "--no-cache": "promptfoo flag forcing fresh eval to detect drift; required for CI determinism."
  },
  "implementation_notes": [
    "Add to package.json scripts: `\"promptfoo:ci\": \"promptfoo eval -c promptfooconfig.yaml --no-cache\"`.",
    "Update `rails` script: change from `bun run guardrails && bun run lint && bun run typecheck` to `bun run guardrails && bun run lint && bun run typecheck && bun run promptfoo:ci`.",
    "Leave `rails:full` untouched (still appends `bun test --bail`).",
    "Verification: `bun run rails` exit code IS the gate — no separate `echo $? | grep` step needed; the `&&` chain already short-circuits on non-zero."
  ]
}
```

---

## P4-6 — DEFERRED: Pool task artifact migration

**Status:** BLOCKED on Phase 2 (`docs/tasks/refactor/39..42`).

Phase 2 (`agent-pool` 39–42) must land first to define the pool task artifact contract (artifact JSON shape: `{ task_id, agent_role, output, references[], confidence }` is a guess — actual shape TBD by Phase 2). Until that contract exists, Phase 4 cannot write a stable BAML class for it, and any Promptfoo suite would be testing fiction.

Action when Phase 2 ships:

1. Re-open this section.
2. Read the artifact contract from `packages/agent/src/pipeline/agent-pool/*` (path TBD by Phase 2).
3. Write packet P4-6 mirroring P4-2/P4-3 structure:
   - `baml_src/pool-artifact.baml` — class definition.
   - `packages/agent/src/lib/structured-output/pool-artifact.ts` — parser.
   - `tests/structured-output-pool-artifact.test.ts` — ≥3 golden + ≥2 edge.
   - Extend `tests/prompts/arbitration.yaml` placeholder suite with real cases (replacing the `pool_artifact_placeholder` skip stub).
4. Risk tier: `public-api` (artifact shape touches inter-agent contract).
5. Diff budget: ≤300 LOC, ≤4 files.

**Do not start P4-6 before Phase 2 merges.** Document the dependency in `docs/tasks/agent-teams/README.md` cross-link.
