# Agent-teams task 00 — Phase 0 docs sync

**Status:** draft contract
**Worker model:** Kimi K2.6 (any weak executor with file-edit + grep)
**Phase:** 0 — Documentation and contract reset
**Risk tier:** ordinary (docs only, no `src/`, no schema, no security)
**Parent reference:** `docs/specs/subbrain-main.md` § "Phase 0 — Documentation
and contract reset" (lines 380-402) and § "Existing task contract inventory →
NEW contracts" line "Phase 0 docs sync" (line 734).

## Phase 0 goal (from main spec)

> One truthful plan and small contracts for Kimi/agent-teams.

The main spec (`docs/specs/subbrain-main.md`) is now canonical. Phase 0
finishes the cleanup so weak executors do not read stale docs and ship code
against an outdated provider/model story.

## Source-of-truth for models

`packages/core/src/lib/model-map.ts` is authoritative. Every claim about which model a
virtual role uses must match that file. Current literal table (copy as-is into
docs):

| Role | Primary | Primary provider | Fallback | Fallback provider |
|---|---|---|---|---|
| `teamlead` | `z-ai/glm-5.1` | `nvidia` | `MiniMax-M2.7` | `minimax` |
| `coder` | `deepseek-ai/deepseek-v4-flash` | `nvidia` | `qwen/qwen3-coder-480b-a35b-instruct` | `nvidia` |
| `critic` | `z-ai/glm-5.1` | `nvidia` | `MiniMax-M2.7` | `minimax` |
| `flash` | `meta/llama-4-maverick-17b-128e-instruct` | `nvidia` | `MiniMax-M2.7` | `minimax` |
| `chaos` | `moonshotai/kimi-k2.6` | `nvidia` | `MiniMax-M2.7` | `minimax` |
| `generalist` | `nvidia/llama-3.3-nemotron-super-49b-v1.5` | `nvidia` | `MiniMax-M2.7` | `minimax` |
| `memory` | `deepseek-ai/deepseek-v4-flash` | `nvidia` | `MiniMax-M2.7` | `minimax` |

Embed model (full literal): `nvidia/llama-3.2-nemoretriever-300m-embed-v1`.
Embed-code model (full literal): `nvidia/nv-embedcode-7b-v1`.
Rerank model (full literal): `nvidia/rerank-qa-mistral-4b`.

If `packages/core/src/lib/model-map.ts` differs from this table at execution time, the
worker must fail with `FAIL: spec-vs-code: model-map drift` instead of
guessing.

## Decomposition into packets

Phase 0 is broken into three sequential Kimi packets. They are independent in
write paths but should run in order P0-1 → P0-2 → P0-3 to keep diffs small
and reviewable.

- **P0-1** — Sync `AGENTS.md` model table, blockquote, request-pipeline
  ASCII, and architecture ASCII from `packages/core/src/lib/model-map.ts`.
- **P0-2** — Sync `README.md` model tables, architecture blocks, env-table
  provider descriptions, project-structure comment, and provider language
  from `packages/core/src/lib/model-map.ts`.
- **P0-3** — Stage the working-tree deletions of obsolete `docs/*` files
  (already moved to `docs/old/неактуальное/`) and add a single forwarding
  README in `docs/old/неактуальное/` pointing back to
  `docs/specs/subbrain-main.md`.

A fourth packet (status headers on `docs/tasks/task-store/Phase-3..6`) is
**not** in scope for Phase 0; the main spec lists those under "NEEDS audit
pass" with a separate acceptance contract. Do not bundle it here.

## Stale-spot inventory (verified line numbers)

### AGENTS.md (current revision)

1. Line ~37 blockquote: `Все роли используют **MiniMax-M2.7**…`.
2. Lines ~39-47: per-role table with `MiniMax-M2.7` everywhere.
3. Line ~97 (request-pipeline ASCII):
   `[1] Pre-processing: Гиппокамп (memory / MiniMax-M2.7) — агентный режим`.
4. Line ~111 (request-pipeline ASCII):
   `[3] Post-processing (memory / MiniMax-M2.7)`.
5. Lines ~175-205 (architecture ASCII): `MiniMax API … teamlead, coder,
   critic, generalist, flash, chaos, memory 20 RPM`.

### README.md (current revision)

1. Line ~21 (top architecture ASCII):
   `GitHub Models / Copilot API (10 RPM) — все LLM-роли`.
2. Line ~33 (upper blockquote):
   `Все LLM-роли используют **GitHub Models (Copilot API)**`.
3. Lines ~37-43 (upper model table): `MiniMax-M2.7 (minimax)` primaries.
4. Line ~45 (embeddings/rerank): does not list embed-code model.
5. Line ~90 (env table row `MINIMAX_API_KEY`):
   `MiniMax Token Plan — основной LLM-провайдер`.
6. Line ~92 (env table row `NVIDIA_API_KEY`):
   `NVIDIA NIM (embed + rerank + LLM fallback)`.
7. Line ~265 (lower blockquote, duplicate of #2):
   `Все LLM-роли используют **MiniMax-M2.7**`.
8. Lines ~267-275 (lower model table): `MiniMax-M2.7` primaries (no fallback
   column).
9. Line ~277:
   `Все LLM-запросы идут через MiniMaxProvider (api.minimax.io)`.
10. Line ~326 (env table row `MINIMAX_API_KEY`, duplicate of #5):
    `MiniMax Token Plan — основной LLM-провайдер`.
11. Line ~328 (env table row `NVIDIA_API_KEY`, duplicate of #6):
    `NVIDIA NIM (embed + rerank + LLM fallback)`.
12. Line ~486 (project-structure block):
    `providers/         # GitHub Copilot + NVIDIA NIM клиенты`.

Total stale spots: **5 in AGENTS.md, 12 in README.md** — line numbers are
approximate (`~`) because the files may shift as edits land; greps in
acceptance use string content, not line numbers, to stay robust.

## Ambiguity flags (read before dispatching)

1. `docs/tasks/task-store/` files use `Phase 3..6` headers without a
   `Status:` field. P0-3 does **not** edit them. Audit packet is deferred.
2. `README.md` has TWO duplicate env-variable tables (lines ~85-108 and
   ~321-344) and TWO duplicate model tables (lines ~37-43 and ~267-275).
   P0-2 must update **both** of each — failure to update the duplicates was
   the cause of the previous round of "fixed but still stale" reports.
3. `README.md` architecture ASCII at lines ~10-27 is the only architecture
   block that mentions `GitHub Models / Copilot API`. The second ASCII block
   at lines ~241-258 already says `NVIDIA NIM API` and is coherent — leave it
   alone.
4. `AGENTS.md` blockquote at line 37 explicitly says "all roles use
   MiniMax-M2.7"; this whole sentence must be replaced, not just the table
   below it. The architecture ASCII block at lines 175-205 also references
   "MiniMax API … teamlead, coder, critic, generalist, flash, chaos, memory"
   — replace with NVIDIA NIM as primary, MiniMax as fallback. **The
   request-pipeline ASCII at lines ~97 and ~111** also mentions
   `memory / MiniMax-M2.7` and must be updated to `memory / DeepSeek V4
   Flash` (or `deepseek-ai/deepseek-v4-flash`).
5. P0-3 only stages already-deleted files and writes one forwarding README;
   it does not move new files to `docs/old/неактуальное/`. The deletions in
   `git status` are working-tree state, not new work.

---

## Packet P0-1 — Sync AGENTS.md model table + pipeline + architecture ASCII

```json
{
  "task_id": "P0-1",
  "goal": "Replace the outdated MiniMax-everywhere claims in AGENTS.md (blockquote, role table, request-pipeline ASCII labels, architecture ASCII labels) with the per-role NVIDIA NIM primary table copied from packages/core/src/lib/model-map.ts.",
  "non_goals": [
    "Do not edit src/, web/, scripts/, tests/, docs/specs/, README.md, or anything outside AGENTS.md.",
    "Do not change role names, add new roles, or remove the OpenAI-compat section.",
    "Do not redraw the architecture ASCII box layout, the request-pipeline ASCII arrows, or the night-cycle ASCII — only swap the model/provider labels inside them.",
    "Do not modify embed/rerank/embed-code model IDs unless they differ from packages/core/src/lib/model-map.ts EMBED_MODEL/EMBED_CODE_MODEL/RERANK_MODEL constants.",
    "Do not edit the memory-section, MCP-tools section, or scheduler section beyond the model labels."
  ],
  "allowed_write_paths": ["AGENTS.md"],
  "read_context": [
    "AGENTS.md",
    "packages/core/src/lib/model-map.ts",
    "docs/specs/subbrain-main.md:46-66",
    "docs/tasks/agent-teams/00-docs-sync.md"
  ],
  "risk_tier": "ordinary",
  "acceptance": [
    "grep -F 'Все роли используют **MiniMax-M2.7**' AGENTS.md ; test $? -eq 1",
    "grep -nF 'memory / MiniMax-M2.7' AGENTS.md ; test $? -eq 1",
    "grep -F 'z-ai/glm-5.1' AGENTS.md | wc -l | awk '$1 >= 2 {exit 0} {exit 1}'",
    "grep -F 'deepseek-ai/deepseek-v4-flash' AGENTS.md | wc -l | awk '$1 >= 2 {exit 0} {exit 1}'",
    "grep -F 'moonshotai/kimi-k2.6' AGENTS.md",
    "grep -F 'nvidia/llama-3.3-nemotron-super-49b-v1.5' AGENTS.md",
    "grep -F 'meta/llama-4-maverick-17b-128e-instruct' AGENTS.md",
    "grep -F 'qwen/qwen3-coder-480b-a35b-instruct' AGENTS.md",
    "grep -nF 'GitHub Models' AGENTS.md ; test $? -eq 1",
    "grep -nF 'Copilot API' AGENTS.md ; test $? -eq 1",
    "awk 'NR>=170 && NR<=210' AGENTS.md | grep -F 'MiniMax API' ; test $? -eq 1",
    "awk 'NR>=170 && NR<=210' AGENTS.md | grep -F 'NVIDIA NIM' | wc -l | awk '$1 >= 1 {exit 0} {exit 1}'",
    "awk 'NR>=85 && NR<=120' AGENTS.md | grep -F 'MiniMax-M2.7' ; test $? -eq 1",
    "bunx markdownlint AGENTS.md || true",
    "bun run scripts/check-file-size.ts",
    "bun run scripts/check-deep-imports.ts"
  ],
  "diff_budget_loc": 140,
  "file_count_max": 1,
  "rollback": "git checkout -- AGENTS.md.",
  "escalation_triggers": [
    "packages/core/src/lib/model-map.ts MODEL_MAP keys differ from {teamlead,coder,critic,flash,chaos,generalist,memory} → FAIL: spec contradicts code: model-map drift.",
    "AGENTS.md contains a section the contract did not anticipate that still claims MiniMax-only routing → FAIL: spec contradicts code: ambiguous AGENTS section, list section heading.",
    "Architecture ASCII at lines 170-210 cannot be edited without redrawing the box layout (e.g. label widths force frame breakage) → FAIL: spec contradicts code: ASCII reflow needed, return current diff.",
    "Any acceptance grep flips after the third edit attempt → FAIL: verifier-loop, return diff so far.",
    "Diff exceeds diff_budget_loc 140 → FAIL: budget, return current diff."
  ],
  "glossary": {
    "primary": "MODEL_MAP[role].primary string in packages/core/src/lib/model-map.ts.",
    "fallback": "MODEL_MAP[role].fallback string in packages/core/src/lib/model-map.ts.",
    "provider": "MODEL_MAP[role].primaryProvider/fallbackProvider literal: 'nvidia' | 'minimax' | 'openrouter' | 'openai-compat'.",
    "role": "Top-level key in MODEL_MAP: teamlead, coder, critic, flash, chaos, generalist, memory.",
    "request-pipeline ASCII": "AGENTS.md fenced-code block around lines 85-120 starting with 'Запрос пользователя' and ending with the post-processing step.",
    "architecture ASCII": "AGENTS.md fenced-code block around lines 170-210 containing 'BUN + ELYSIA' and the provider boxes."
  }
}
```

### P0-1 implementation hints (non-binding)

- The blockquote at AGENTS.md line ~37 ("Все роли используют
  **MiniMax-M2.7**…") becomes: "Per-role NVIDIA NIM primaries (см.
  `packages/core/src/lib/model-map.ts`); MiniMax-M2.7 used as fallback for most roles."
- The role table directly below it (lines ~39-47) must be replaced with the
  literal table from this contract.
- The request-pipeline ASCII at AGENTS.md lines ~97 and ~111 currently says
  `memory / MiniMax-M2.7`. Replace both with `memory / DeepSeek V4 Flash`
  (do not include the full `deepseek-ai/` prefix — the ASCII has narrow
  columns and the human-readable name fits without breaking the box).
- The architecture ASCII at AGENTS.md lines ~175-205 currently says
  `MiniMax API … teamlead, coder, critic, generalist, flash, chaos, memory
  20 RPM`. Replace with `NVIDIA NIM 40 RPM … teamlead, coder, critic,
  generalist, flash, chaos, memory` and put MiniMax in the fallback role
  column. Do not redraw the box layout — only swap the labels.
- Leave the OpenAI-compat block (`OPENAI_COMPAT_ENABLED=true`) intact.
- Embed-code reference: if AGENTS.md mentions `nv-embedcode-7b-v1` without
  the `nvidia/` prefix, fix to the full literal `nvidia/nv-embedcode-7b-v1`.

---

## Packet P0-2 — Sync README.md model tables, ASCII, env-tables, and project-structure

```json
{
  "task_id": "P0-2",
  "goal": "Replace stale GitHub Models / Copilot and MiniMax-everywhere claims across all twelve identified spots in README.md (architecture ASCII, both model tables, both env-variable tables, embeddings line, MiniMaxProvider sentence, project-structure comment) with the per-role NVIDIA NIM primary table and provider list copied from packages/core/src/lib/model-map.ts.",
  "non_goals": [
    "Do not edit src/, web/, scripts/, tests/, docs/, AGENTS.md, or any file outside README.md.",
    "Do not rewrite Quickstart, Docker, Deploy, Continue config, or API endpoints sections beyond the provider claim swap.",
    "Do not change role names, add new roles, or remove the project-structure block.",
    "Do not delete the duplicated lower model table or the duplicated env-variable table — replace their contents in place to keep diff localized and avoid breaking inbound links.",
    "Do not touch the second architecture ASCII block at lines ~241-258 — it already says NVIDIA NIM API and is coherent."
  ],
  "allowed_write_paths": ["README.md"],
  "read_context": [
    "README.md",
    "packages/core/src/lib/model-map.ts",
    "docs/specs/subbrain-main.md:46-66",
    "docs/tasks/agent-teams/00-docs-sync.md"
  ],
  "risk_tier": "ordinary",
  "acceptance": [
    "grep -nF 'GitHub Models' README.md ; test $? -eq 1",
    "grep -nF 'Copilot API' README.md ; test $? -eq 1",
    "grep -nF 'GitHub Copilot' README.md ; test $? -eq 1",
    "grep -nF 'MiniMaxProvider' README.md ; test $? -eq 1",
    "grep -nF 'основной LLM-провайдер' README.md ; test $? -eq 1",
    "grep -nF 'LLM fallback' README.md ; test $? -eq 1",
    "grep -F 'MiniMax-M2.7' README.md | wc -l | awk '$1 <= 9 {exit 0} {exit 1}'",
    "grep -F 'z-ai/glm-5.1' README.md | wc -l | awk '$1 >= 2 {exit 0} {exit 1}'",
    "grep -F 'deepseek-ai/deepseek-v4-flash' README.md | wc -l | awk '$1 >= 2 {exit 0} {exit 1}'",
    "grep -F 'moonshotai/kimi-k2.6' README.md",
    "grep -F 'nvidia/llama-3.3-nemotron-super-49b-v1.5' README.md",
    "grep -F 'meta/llama-4-maverick-17b-128e-instruct' README.md",
    "grep -F 'qwen/qwen3-coder-480b-a35b-instruct' README.md",
    "grep -F 'nvidia/nv-embedcode-7b-v1' README.md",
    "grep -nF '10 RPM' README.md ; test $? -eq 1",
    "grep -nF 'GitHub Copilot + NVIDIA NIM' README.md ; test $? -eq 1",
    "grep -F 'NVIDIA NIM' README.md | wc -l | awk '$1 >= 3 {exit 0} {exit 1}'",
    "bunx markdownlint README.md || true",
    "bun run scripts/check-file-size.ts",
    "bun run scripts/check-deep-imports.ts"
  ],
  "diff_budget_loc": 220,
  "file_count_max": 1,
  "rollback": "git checkout -- README.md.",
  "escalation_triggers": [
    "packages/core/src/lib/model-map.ts MODEL_MAP keys differ from {teamlead,coder,critic,flash,chaos,generalist,memory} → FAIL: spec contradicts code: model-map drift.",
    "README.md still contains the string 'GitHub Models', 'Copilot API', 'GitHub Copilot', 'MiniMaxProvider', or '10 RPM' after the planned edits and the remaining occurrence is not inside a fenced code block dated as historical → FAIL: spec contradicts code: stale provider claim, list line numbers.",
    "README.md upper and lower model tables disagree on the primary model for any role after the edit → FAIL: spec contradicts code: table drift.",
    "Any acceptance grep flips after the third edit attempt → FAIL: verifier-loop, return diff so far.",
    "Diff exceeds diff_budget_loc 220 → FAIL: budget, return current diff."
  ],
  "glossary": {
    "primary": "MODEL_MAP[role].primary string in packages/core/src/lib/model-map.ts.",
    "fallback": "MODEL_MAP[role].fallback string in packages/core/src/lib/model-map.ts.",
    "provider": "MODEL_MAP[role].primaryProvider/fallbackProvider literal: 'nvidia' | 'minimax' | 'openrouter' | 'openai-compat'.",
    "role": "Top-level key in MODEL_MAP: teamlead, coder, critic, flash, chaos, generalist, memory.",
    "upper model table": "README.md table in the '## 🤖 Провайдеры и модели' section, lines ~37-43.",
    "lower model table": "README.md table in the '## Модели (виртуальные роли)' section, lines ~267-275 — note no fallback column; update primaries only.",
    "upper env table": "README.md '## Переменные окружения' table, lines ~85-108.",
    "lower env table": "README.md duplicate '## Переменные окружения' table, lines ~321-344. Both tables describe the same env vars; update both."
  }
}
```

### P0-2 implementation hints (non-binding)

- README.md has TWELVE stale spots, grouped:
  1. **Top architecture ASCII (line ~21):** replace
     `GitHub Models / Copilot API (10 RPM) — все LLM-роли` with
     `NVIDIA NIM (40 RPM) — primary LLM-роли`. Move MiniMax into the
     fallback line.
  2. **Upper blockquote (line ~33):** replace
     `Все LLM-роли используют **GitHub Models (Copilot API)**` with
     `Per-role NVIDIA NIM primaries (см. packages/core/src/lib/model-map.ts); MiniMax-M2.7
     fallback`.
  3. **Upper model table (lines ~37-43):** rewrite each row to match the
     literal table at the top of this contract.
  4. **Embeddings/Rerank line (line ~45):** add the embed-code model so the
     line reads `Embeddings: nvidia/llama-3.2-nemoretriever-300m-embed-v1 ·
     Embed-code: nvidia/nv-embedcode-7b-v1 · Rerank:
     nvidia/rerank-qa-mistral-4b`.
  5. **Upper env table `MINIMAX_API_KEY` row (line ~90):** change description
     from `MiniMax Token Plan — основной LLM-провайдер` to
     `MiniMax Token Plan — fallback LLM-провайдер`.
  6. **Upper env table `NVIDIA_API_KEY` row (line ~92):** change from
     `NVIDIA NIM (embed + rerank + LLM fallback)` to
     `NVIDIA NIM (primary LLM provider + embed + rerank)`.
  7. **Lower blockquote (line ~265):** replace
     `Все LLM-роли используют **MiniMax-M2.7**` with the same per-role NIM
     line as #2.
  8. **Lower model table (lines ~267-275):** rewrite primaries to match the
     literal table at the top of this contract; keep the column shape (no
     fallback column).
  9. **MiniMaxProvider sentence (line ~277):** replace
     `Все LLM-запросы идут через MiniMaxProvider (api.minimax.io)…` with
     `LLM-запросы идут через NVIDIA NIM (api.nvidia.com); fallback —
     MiniMax (api.minimax.io). Router разрешает виртуальное имя → real
     model → провайдер и управляет фоллбэками.`
  10. **Lower env table `MINIMAX_API_KEY` row (line ~326):** same as #5.
  11. **Lower env table `NVIDIA_API_KEY` row (line ~328):** same as #6.
  12. **Project-structure comment (line ~486):** replace
      `providers/         # GitHub Copilot + NVIDIA NIM клиенты` with
      `providers/         # NVIDIA NIM + MiniMax + OpenRouter клиенты`.
- Leave the second ASCII block (lines ~241-258) that mentions only
  `NVIDIA NIM API` and SQLite alone; it is already coherent.
- The upper-blockquote and lower-blockquote replacements should be
  string-identical to keep the diff small and the two duplicates in sync.

---

## Packet P0-3 — Stage doc deletions and add forwarding README

```json
{
  "task_id": "P0-3",
  "goal": "Stage the working-tree deletions of obsolete docs already moved to docs/old/неактуальное/ via `git rm` and add docs/old/неактуальное/README.md pointing readers to docs/specs/subbrain-main.md.",
  "non_goals": [
    "Do not delete or move any file under docs/tasks/, docs/specs/, docs/superpowers/, web/, src/, scripts/, or tests/.",
    "Do not edit AGENTS.md or README.md.",
    "Do not move new files into docs/old/неактуальное/ — that directory is already populated; this packet only stages what git already shows as deleted from the working tree.",
    "Do not commit; staging only. The parent reviewer creates the commit.",
    "Do not run git rm on any file that does not also already exist under docs/old/неактуальное/ at a corresponding archive path."
  ],
  "allowed_write_paths": [
    "docs/old/неактуальное/README.md"
  ],
  "read_context": [
    "docs/specs/subbrain-main.md:380-402",
    "docs/tasks/agent-teams/00-docs-sync.md",
    "docs/old/неактуальное/"
  ],
  "risk_tier": "ordinary",
  "acceptance": [
    "test -f docs/old/неактуальное/README.md",
    "grep -F 'docs/specs/subbrain-main.md' docs/old/неактуальное/README.md",
    "git diff --cached --name-status -- docs/01-refactor-plan.md docs/02-audit.md docs/03-agent-workspace.md docs/04-dev-machine.md docs/14-audit-2026-04-20.md docs/improvements-roadmap.md docs/night-cycle.md docs/prompts-audit.md docs/audits/2026-04-23-global-refactor-plan.md | awk '$1==\"D\"{c++} END {exit (c==9?0:1)}'",
    "git diff --name-status -- docs/01-refactor-plan.md docs/02-audit.md docs/03-agent-workspace.md docs/04-dev-machine.md docs/14-audit-2026-04-20.md docs/improvements-roadmap.md docs/night-cycle.md docs/prompts-audit.md docs/audits/2026-04-23-global-refactor-plan.md | awk '$1==\"D\"{c++} END {exit (c==0?0:1)}'",
    "git diff --cached --name-status -- 'docs/completed/*.md' | awk '$1==\"D\"{c++} END {exit (c>=12?0:1)}'",
    "git diff --name-status -- 'docs/completed/*.md' | awk '$1==\"D\"{c++} END {exit (c==0?0:1)}'",
    "git ls-files --error-unmatch docs/01-refactor-plan.md docs/02-audit.md docs/03-agent-workspace.md docs/04-dev-machine.md docs/14-audit-2026-04-20.md docs/improvements-roadmap.md docs/night-cycle.md docs/prompts-audit.md docs/audits/2026-04-23-global-refactor-plan.md 2>/dev/null ; test $? -ne 0",
    "for f in docs/completed/01-server-skeleton.md docs/completed/02-database-schema.md docs/completed/03-model-router.md docs/completed/04-mcp-tools.md docs/completed/05-rag-pipeline.md docs/completed/06-agent-pipeline.md docs/completed/07-auth.md docs/completed/08-observability.md docs/completed/09-arbitration.md docs/completed/10-night-cycle.md docs/completed/11-code-tools-roadmap.md docs/completed/13-chaos-advisor.md ; do git ls-files --error-unmatch \"$f\" 2>/dev/null && exit 1 ; done ; exit 0",
    "bunx tsc --noEmit",
    "bun run scripts/check-file-size.ts",
    "bun run scripts/check-deep-imports.ts"
  ],
  "diff_budget_loc": 60,
  "file_count_max": 1,
  "rollback": "git restore --staged docs/01-refactor-plan.md docs/02-audit.md docs/03-agent-workspace.md docs/04-dev-machine.md docs/14-audit-2026-04-20.md docs/improvements-roadmap.md docs/night-cycle.md docs/prompts-audit.md docs/audits/2026-04-23-global-refactor-plan.md docs/completed/ ; rm -f docs/old/неактуальное/README.md.",
  "escalation_triggers": [
    "Any of the listed deleted files still exists at its original path on disk and is NOT shown as deleted in `git status` → FAIL: spec contradicts code: deletion not yet performed, list file.",
    "docs/old/неактуальное/ does not contain the corresponding archive copy of a file the contract wants staged for deletion (e.g. docs/old/неактуальное/01-refactor-plan.md missing) → FAIL: spec contradicts code: archive missing, list file.",
    "git status shows working-tree deletions for files outside the listed nine + docs/completed/* set → FAIL: scope-violation, list extra files.",
    "Diff exceeds diff_budget_loc 60 → FAIL: budget."
  ],
  "glossary": {
    "stage deletion": "Run `git rm <path>` (or `git add -u <path>` if working tree no longer has the file) to mark the working-tree deletion as a staged change. Do not commit. The acceptance greps require column 1 == 'D' in `git diff --cached --name-status` (staged) and zero column 1 == 'D' in `git diff --name-status` (unstaged) — i.e. all nine files plus the docs/completed set must be fully staged, no half-staged state.",
    "forwarding README": "A 5-15 line markdown file at docs/old/неактуальное/README.md whose only job is to tell readers that this directory is the archive of pre-2026-05 docs and the canonical plan lives at docs/specs/subbrain-main.md."
  }
}
```

### P0-3 implementation hints (non-binding)

- Files to stage as deletions (already removed from working tree, archive
  copies live under `docs/old/неактуальное/`):
  - `docs/01-refactor-plan.md`
  - `docs/02-audit.md`
  - `docs/03-agent-workspace.md`
  - `docs/04-dev-machine.md`
  - `docs/14-audit-2026-04-20.md`
  - `docs/improvements-roadmap.md`
  - `docs/night-cycle.md`
  - `docs/prompts-audit.md`
  - `docs/audits/2026-04-23-global-refactor-plan.md`
  - `docs/completed/01-server-skeleton.md` … `docs/completed/13-chaos-advisor.md`
    (12 files, all already moved to `docs/old/неактуальное/completed/`).
- Use `git rm <path>` per file (works even when the working-tree file is
  already gone — git removes it from the index). `git add -u <path>` is an
  acceptable equivalent.
- The acceptance commands distinguish staged vs unstaged via
  `git diff --cached --name-status` (staged-only, column 1 is the literal
  `D`) and `git diff --name-status` (unstaged, also literal `D` in column 1
  but only counts working-tree-vs-index). Both must match: nine staged
  deletions of root docs + at least twelve staged deletions of
  docs/completed/*; zero unstaged deletions for either group.
- The new `docs/old/неактуальное/README.md` body should state: this
  directory archives docs that predate 2026-05; canonical plan lives at
  `docs/specs/subbrain-main.md`; active task contracts under
  `docs/tasks/`.

---

## Phase 0 done-criteria checklist

After P0-1, P0-2, P0-3 all return `OK`:

- `grep -nF 'GitHub Models' README.md AGENTS.md` returns nothing.
- `grep -nF 'Copilot API' README.md AGENTS.md` returns nothing.
- `grep -nF 'GitHub Copilot' README.md` returns nothing.
- `grep -nF 'MiniMaxProvider' README.md` returns nothing.
- `grep -niE 'все .{0,20} используют .{0,20}MiniMax' AGENTS.md README.md`
  returns nothing.
- `grep -F 'z-ai/glm-5.1' README.md AGENTS.md` returns at least four
  occurrences total (≥2 in each file).
- `grep -F 'deepseek-ai/deepseek-v4-flash' README.md AGENTS.md` returns at
  least four occurrences total.
- `grep -F 'nvidia/nv-embedcode-7b-v1' README.md AGENTS.md` returns at least
  one occurrence total.
- `git diff --cached --name-status -- docs/01-refactor-plan.md
  docs/02-audit.md` shows column-1 `D` for both files (staged-only).
- `git diff --name-status -- docs/01-refactor-plan.md docs/02-audit.md`
  shows nothing for those files (no unstaged remainder).
- `docs/old/неактуальное/README.md` exists and references
  `docs/specs/subbrain-main.md`.

If any check fails, the parent reviewer reopens the matching packet rather
than dispatching new work.
