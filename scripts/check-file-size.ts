#!/usr/bin/env bun
/**
 * Guardrail: file-cap 150 lines (FILE-SIZE-1).
 *
 * Walks src/, web/app/, scripts/ (+.ts/.tsx/.vue/.mts/.cts), counts ALL lines
 * (blank+comments+code), reports violations vs WHITELIST (canonical + transitional).
 *
 * Default: STRICT (exit 1 on any violation). Set STRICT_FILE_RULES=0 for warn-only.
 *
 * Run: `bun run scripts/check-file-size.ts`
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
function globPackagesSrc(): string[] {
  try {
    const dirs = readdirSync(join(ROOT, "packages"));
    return dirs
      .filter((d) => {
        const p = join(ROOT, "packages", d);
        try {
          return statSync(p).isDirectory() && existsSync(join(p, "src"));
        } catch {
          return false;
        }
      })
      .map((d) => `packages/${d}/src`);
  } catch {
    return [];
  }
}

const SCAN = ["src", "web/app", "scripts", ...globPackagesSrc()];
const SKIP_DIRS = new Set(["node_modules", ".nuxt", ".output", "dist", "build"]);
const EXT = /\.(ts|tsx|vue|mts|cts)$/;
const DEFAULT_CAP = 150;

// Permanent whitelist — каждое исключение требует обоснования (см. SKILL.md §1).
export const CANONICAL_WHITELIST: Record<string, number> = {
  "packages/agent/src/pipeline/agent-loop/system-prompt.ts": 300,
  "packages/agent/src/rag/pipeline/index.ts": 200,
  "packages/core/src/db/schema.ts": 1500,
  "packages/core/src/db/index.ts": 500,
  "packages/core/src/db/types.ts": 300,
  "packages/core/src/lib/model-map.ts": 300,
};

// Glob-whitelist (path glob → cap). Keep small, justified.
export const CANONICAL_GLOB_WHITELIST: Array<{ glob: RegExp; cap: number; label: string }> = [
  {
    glob: /^packages\/agent\/src\/mcp\/registry\/[^/]+\.tools\.ts$/,
    cap: 250,
    label: "mcp/registry/*.tools.ts",
  },
];

// Transitional — pre-existing oversize, locked at current LOC (snapshot 2026-04-28).
// File не может расти; split / squeeze → удалить строку. Closes when empty.
export const TRANSITIONAL_WHITELIST: Record<string, number> = {
  "scripts/check-file-size.ts": 200,
  "packages/agent/src/pipeline/context-compressor.ts": 300,
  "packages/core/src/lib/logger.ts": 210,
  "packages/agent/src/mcp/registry/agent-meta.tools.ts": 290,
  "packages/agent/src/pipeline/agent-pipeline/post/extractors.ts": 281,
  "packages/agent/src/mcp/registry/tool-registry.ts": 273,
  "packages/agent/src/pipeline/agent-pipeline/post/hippocampus.ts": 272,
  "scripts/migrate-tasks-from-memory.ts": 263,
  "web/app/composables/useMemory.ts": 279,
  "packages/agent/src/pipeline/night-cycle/post-steps.ts": 262,
  "packages/agent/src/mcp/tools/memory/write-shared.ts": 253,
  "packages/agent/src/pipeline/agent-pipeline/post/link-related.ts": 246,
  "packages/agent/src/pipeline/night-cycle/steps/cross-layer-dedup.ts": 245,
  "packages/agent/src/pipeline/agent-pipeline/pre/exec-summary.ts": 245,
  "packages/agent/src/pipeline/agent-pipeline/post/dedupe.ts": 241,
  "packages/agent/src/pipeline/agent-loop/tool-runner.ts": 250,
  "packages/agent/src/pipeline/agent-loop/shared.ts": 224,
  "packages/agent/src/pipeline/agent-pipeline/post/validators.ts": 211,
  "packages/agent/src/rag/report-context.ts": 208,
  "packages/agent/src/pipeline/night-cycle/steps/memory-dedup-utils.ts": 202,
  "packages/agent/src/scheduler/telegram-poller.ts": 202,
  "web/app/components/ChatSidebar.vue": 202,
  "packages/agent/src/mcp/tools/memory-curation-tools.ts": 201,
  "packages/agent/src/pipeline/night-cycle/prune/tasks.ts": 198,
  "packages/agent/src/pipeline/night-cycle/steps/reflect.ts": 194,
  "web/app/components/memory/MemoryList.vue": 193,
  "packages/agent/src/scheduler/freelance/index.ts": 188,
  "packages/agent/src/pipeline/night-cycle/prune/tasks-classify.ts": 184,
  "web/app/components/TaskFormModal.vue": 183,
  "packages/core/src/db/tables/log.ts": 215,
  "packages/core/src/db/tables/tasks.ts": 305,
  "packages/agent/src/pipeline/agent-pipeline/phases/post.ts": 200,
  "packages/agent/src/pipeline/agent-pipeline/phases/pre.ts": 165,
  "packages/agent/src/services/memory/service.ts": 180,
  "packages/agent/src/mcp/executor/index.ts": 181,
  "packages/agent/src/scheduler/telegram-commands.ts": 179,
  "web/app/components/TaskRow.vue": 174,
  "packages/providers/src/index.ts": 172,
  "packages/providers/src/nvidia.ts": 172,
  "packages/agent/src/pipeline/agent-pipeline/phases/stream.ts": 180,
  "packages/agent/src/pipeline/night-cycle/steps/focus-rewrite.ts": 165,
  "packages/providers/src/think-tag-transform.ts": 163,
  "packages/agent/src/pipeline/agent-loop/code-tools/sandbox.ts": 162,
  "packages/agent/src/pipeline/night-cycle/prune/context.ts": 162,
  "packages/agent/src/pipeline/agent-loop/prompt-blocks/tasks.ts": 157,
  "packages/agent/src/pipeline/agent-loop/step.ts": 155,
  "web/app/pages/freelance.vue": 152,
  "packages/core/src/lib/auth.ts": 36,
  "packages/core/src/services/auth.service.ts": 66,
  "packages/agent/src/pipeline/night-cycle/janitor/phase-bc.ts": 165,
  "packages/core/src/lib/fts-utils.ts": 175,
  "packages/core/src/lib/pii-scrub.ts": 220,
  "packages/agent/src/scheduler/free-agent.ts": 157,
  "packages/server/src/app/deps.ts": 400,
  "packages/server/src/routes/memory.ts": 300,
  "packages/server/src/app/schedulers.ts": 200,
  "packages/providers/src/rate-limiter.ts": 200,
  "packages/server/src/mcp-transport/mcp-protocol.ts": 200,
  "packages/server/src/routes/metrics.ts": 200,
};

function lookupCap(rel: string): number {
  // Transitional may exceed canonical (e.g. logger.ts:263 vs canonical:200 pre-microPR);
  // take max so transitional only relaxes, never tightens. Remove transitional row → canonical wins.
  let cap = DEFAULT_CAP;
  if (rel in CANONICAL_WHITELIST) cap = Math.max(cap, CANONICAL_WHITELIST[rel]);
  if (rel in TRANSITIONAL_WHITELIST) cap = Math.max(cap, TRANSITIONAL_WHITELIST[rel]);
  for (const { glob, cap: g } of CANONICAL_GLOB_WHITELIST) {
    if (glob.test(rel)) cap = Math.max(cap, g);
  }
  return cap;
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (EXT.test(entry)) out.push(full);
  }
  return out;
}

function countLines(path: string): number {
  return readFileSync(path, "utf8").split("\n").length;
}

function toRel(abs: string): string {
  return relative(ROOT, abs).split(sep).join("/");
}

const strict = process.env.STRICT_FILE_RULES !== "0";
const violations: Array<{ path: string; lines: number; cap: number }> = [];

for (const root of SCAN) {
  for (const file of walk(join(ROOT, root))) {
    const rel = toRel(file);
    const lines = countLines(file);
    const cap = lookupCap(rel);
    if (lines > cap) violations.push({ path: rel, lines, cap });
  }
}

if (violations.length > 0) {
  console.error(`✗ ${violations.length} file-size violation(s):`);
  for (const v of violations.sort((a, b) => b.lines - a.lines)) {
    console.error(`  ${v.path}: ${v.lines} > ${v.cap}`);
  }
  console.error(
    `\nFix: split file or request whitelist entry via PR. See SKILL.md §1 + docs/tasks/refactor/28-file-size-150-limit.md`,
  );
  if (strict) process.exit(1);
  console.error("(STRICT_FILE_RULES=0 — warn-only)");
} else {
  console.log("✓ all files within cap (default 150, see WHITELIST in scripts/check-file-size.ts)");
}
