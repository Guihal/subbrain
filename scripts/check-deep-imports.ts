#!/usr/bin/env bun
/**
 * Guardrail: deep-import ban (FILE-SIZE-1 § minimal coupling).
 *
 * Violation = relative import where (a) NOT `import type`, (b) ≥3 segments
 * past leading `..`s, AND (c) target's parent dir has `index.{ts,tsx,vue,mts,cts}`.
 *
 * Rationale: split-folders expose a single public `index.ts` — bypassing it
 * couples consumer to internals. `import type` skipped (compile-time only).
 *
 * Default STRICT (exit 1). Set STRICT_FILE_RULES=0 for warn-only.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const SCAN = ["src", "web/app", "scripts"];
const SKIP_DIRS = new Set(["node_modules", ".nuxt", ".output", "dist", "build"]);
const EXT = /\.(ts|tsx|vue|mts|cts)$/;
const SEGMENT_THRESHOLD = 3;

// Transitional — known deep imports awaiting barrel/index re-export in their target folder.
// Format: `<source-rel>:<importPath>`. Removed PR-by-PR as targets expose proper public API.
const TRANSITIONAL_DEEP_IMPORTS = new Set<string>([
  "scripts/freelance-probe.ts:../src/mcp/snapshot",
  "scripts/migrate-tasks-from-memory.ts:../src/pipeline/night-cycle/prune/tasks-classify",
  "src/mcp/registry/code-mgmt.tools.ts:../../pipeline/agent-loop/code-tools/sandbox",
  "src/mcp/registry/code-mgmt.tools.ts:../../pipeline/agent-loop/code-tools/code-tool-validators",
]);
const INDEX_FILES = ["index.ts", "index.tsx", "index.vue", "index.mts", "index.cts"];
const TARGET_EXTS = [".ts", ".tsx", ".vue", ".mts", ".cts"];
const IMPORT_RE = /^\s*import\s+(type\s+)?[\s\S]*?from\s+["'](\.[^"']+)["']/gm;

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

function resolveTarget(fromFile: string, importPath: string): string | null {
  const base = resolve(dirname(fromFile), importPath);
  if (existsSync(base) && statSync(base).isFile()) return base;
  for (const ext of TARGET_EXTS) {
    if (existsSync(base + ext)) return base + ext;
  }
  if (existsSync(base) && statSync(base).isDirectory()) {
    for (const idx of INDEX_FILES) {
      const p = join(base, idx);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

function parentHasIndex(targetFile: string): boolean {
  const parent = dirname(targetFile);
  for (const idx of INDEX_FILES) {
    const p = join(parent, idx);
    if (existsSync(p) && p !== targetFile) return true;
  }
  return false;
}

function segmentsPastDotDot(path: string): number {
  const parts = path.split("/").filter((p) => p.length > 0);
  let i = 0;
  while (i < parts.length && (parts[i] === "." || parts[i] === "..")) i++;
  return parts.length - i;
}

function toRel(abs: string): string {
  return relative(ROOT, abs).split(sep).join("/");
}

const strict = process.env.STRICT_FILE_RULES !== "0";
const violations: Array<{ file: string; line: number; importPath: string; target: string }> = [];

for (const root of SCAN) {
  for (const file of walk(join(ROOT, root))) {
    const text = readFileSync(file, "utf8");
    IMPORT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = IMPORT_RE.exec(text)) !== null) {
      const isTypeOnly = !!m[1];
      const importPath = m[2];
      if (isTypeOnly) continue;
      if (segmentsPastDotDot(importPath) < SEGMENT_THRESHOLD) continue;
      const target = resolveTarget(file, importPath);
      if (!target) continue;
      if (!parentHasIndex(target)) continue;
      const sourceRel = toRel(file);
      if (TRANSITIONAL_DEEP_IMPORTS.has(`${sourceRel}:${importPath}`)) continue;
      const line = text.slice(0, m.index).split("\n").length;
      violations.push({ file: sourceRel, line, importPath, target: toRel(target) });
    }
  }
}

if (violations.length > 0) {
  console.error(`✗ ${violations.length} deep-import violation(s):`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line} → "${v.importPath}" (target: ${v.target}; use parent index.ts)`);
  }
  console.error(`\nFix: import from the folder's index.ts (single public entry), or use \`import type\` if compile-time only.`);
  if (strict) process.exit(1);
  console.error("(STRICT_FILE_RULES=0 — warn-only)");
} else {
  console.log("✓ no deep imports (≥3 segments past `..` into folder with index.ts)");
}
