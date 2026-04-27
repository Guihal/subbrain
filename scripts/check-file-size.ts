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
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const SCAN = ["src", "web/app", "scripts"];
const SKIP_DIRS = new Set(["node_modules", ".nuxt", ".output", "dist", "build"]);
const EXT = /\.(ts|tsx|vue|mts|cts)$/;
const DEFAULT_CAP = 150;

// Permanent whitelist — каждое исключение требует обоснования (см. SKILL.md §1).
export const CANONICAL_WHITELIST: Record<string, number> = {
  "src/db/schema.ts": 1500,
  "src/db/index.ts": 500,
  "src/db/types.ts": 300,
  "src/app/deps.ts": 500,
  "src/lib/model-map.ts": 300,
  "src/lib/logger.ts": 200,
  "src/pipeline/agent-loop/system-prompt.ts": 300,
  "src/rag/pipeline/index.ts": 200,
};

// Glob-whitelist (path glob → cap). Keep small, justified.
export const CANONICAL_GLOB_WHITELIST: Array<{ glob: RegExp; cap: number; label: string }> = [
  { glob: /^src\/mcp\/registry\/[^/]+\.tools\.ts$/, cap: 250, label: "mcp/registry/*.tools.ts" },
];

// Transitional — pre-existing oversize, locked at current LOC (snapshot 2026-04-28).
// File не может расти; split / squeeze → удалить строку. Closes when empty.
export const TRANSITIONAL_WHITELIST: Record<string, number> = {
  "scripts/check-file-size.ts": 170,
  "src/lib/logger.ts": 263,
  "src/rag/pipeline.ts": 700,
  "src/mcp/tools/memory-tools.ts": 473,
  "src/db/tables/memory.ts": 452,
  "src/pipeline/arbitration-room.ts": 421,
  "src/db/tables/shared.ts": 397,
  "src/services/memory.service.ts": 381,
  "src/repositories/memory.repo.ts": 381,
  "src/mcp/executor.ts": 362,
  "src/telegram/userbot.ts": 349,
  "src/telegram/bot.ts": 344,
  "src/services/chat.service.ts": 324,
  "src/mcp/playwright-client.ts": 315,
  "src/pipeline/context-compressor.ts": 300,
  "src/mcp/registry/agent-meta.tools.ts": 290,
  "src/pipeline/agent-pipeline/post/extractors.ts": 281,
  "src/mcp/registry/tool-registry.ts": 273,
  "src/pipeline/agent-pipeline/post/hippocampus.ts": 272,
  "scripts/migrate-tasks-from-memory.ts": 263,
  "src/db/tables/tasks.ts": 260,
  "web/app/composables/useMemory.ts": 249,
  "src/routes/memory.ts": 246,
  "src/pipeline/agent-pipeline/pre/exec-summary.ts": 245,
  "src/pipeline/agent-pipeline/post/dedupe.ts": 241,
  "src/pipeline/agent-loop/tool-runner.ts": 241,
  "src/routes/tasks.ts": 229,
  "src/pipeline/agent-pipeline/post/link-related.ts": 226,
  "src/pipeline/agent-loop/shared.ts": 224,
  "src/providers/copilot/auth.ts": 217,
  "src/pipeline/agent-pipeline/post/validators.ts": 211,
  "src/rag/report-context.ts": 208,
  "src/pipeline/night-cycle/steps/memory-dedup-utils.ts": 202,
  "src/scheduler/telegram-poller.ts": 202,
  "web/app/components/ChatSidebar.vue": 202,
  "src/mcp/tools/memory-curation-tools.ts": 201,
  "src/pipeline/night-cycle/prune/tasks.ts": 198,
  "src/app/schedulers.ts": 198,
  "src/pipeline/night-cycle/steps/reflect.ts": 194,
  "src/pipeline/night-cycle/steps/cross-layer-dedup.ts": 194,
  "web/app/components/memory/MemoryList.vue": 193,
  "src/scheduler/freelance/index.ts": 188,
  "src/pipeline/night-cycle/prune/tasks-classify.ts": 184,
  "web/app/components/TaskFormModal.vue": 183,
  "src/db/tables/log.ts": 180,
  "src/pipeline/agent-pipeline/phases/post.ts": 179,
  "src/scheduler/telegram-commands.ts": 179,
  "src/lib/fts-utils.ts": 175,
  "web/app/components/TaskRow.vue": 174,
  "src/pipeline/night-cycle/post-steps.ts": 173,
  "src/providers/index.ts": 172,
  "src/providers/nvidia.ts": 172,
  "src/pipeline/agent-pipeline/phases/stream.ts": 168,
  "src/pipeline/night-cycle/steps/focus-rewrite.ts": 165,
  "src/lib/rate-limiter.ts": 164,
  "src/providers/think-tag-transform.ts": 163,
  "src/pipeline/agent-loop/code-tools/sandbox.ts": 162,
  "src/pipeline/night-cycle/prune/context.ts": 162,
  "src/mcp/mcp-protocol.ts": 160,
  "src/pipeline/agent-loop/prompt-blocks/tasks.ts": 157,
  "src/pipeline/agent-loop/step.ts": 155,
  "web/app/pages/freelance.vue": 152,
  "src/lib/http-client.ts": 151,
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
  try { entries = readdirSync(dir); } catch { return out; }
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
  console.error(`\nFix: split file or request whitelist entry via PR. See SKILL.md §1 + docs/tasks/refactor/28-file-size-150-limit.md`);
  if (strict) process.exit(1);
  console.error("(STRICT_FILE_RULES=0 — warn-only)");
} else {
  console.log("✓ all files within cap (default 150, see WHITELIST in scripts/check-file-size.ts)");
}
