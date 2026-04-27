/**
 * Repo-rules guardrails (FILE-SIZE-1).
 *
 * 5 strict tests: file-size cap, no deep imports, no SQL in routes,
 * no fetch in pages/components, whitelist sync between SKILL.md and
 * scripts/check-file-size.ts CANONICAL_WHITELIST.
 *
 * Wraps the two CLI scripts (single source of truth) for cap + import logic.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CANONICAL_WHITELIST } from "../scripts/check-file-size";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const SKIP_DIRS = new Set(["node_modules", ".nuxt", ".output", "dist", "build"]);

// SQL in routes — only these are pre-existing W2-* (removed as those PRs ship).
// W2-2 (2026-04-28) — pruned: src/routes/tasks.ts SQL → TaskRepository.
const TRANSITIONAL_SQL_ROUTES = new Set<string>();

function walk(dir: string, ext: RegExp, out: string[] = []): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, ext, out);
    else if (ext.test(entry)) out.push(full);
  }
  return out;
}

function rel(abs: string): string {
  return abs.slice(ROOT.length + 1);
}

describe("repo-rules — FILE-SIZE-1 guardrails", () => {
  test("check-file-size script passes in STRICT mode", () => {
    const proc = Bun.spawnSync({
      cmd: ["bun", "run", "scripts/check-file-size.ts"],
      env: { ...process.env, STRICT_FILE_RULES: "1" },
      cwd: ROOT,
    });
    expect(proc.exitCode).toBe(0);
  });

  test("check-deep-imports script passes in STRICT mode", () => {
    const proc = Bun.spawnSync({
      cmd: ["bun", "run", "scripts/check-deep-imports.ts"],
      env: { ...process.env, STRICT_FILE_RULES: "1" },
      cwd: ROOT,
    });
    expect(proc.exitCode).toBe(0);
  });

  test("no SQL in src/routes/ (logic→repository boundary)", () => {
    const sqlRe = /\b(?:SELECT\b|INSERT\s+INTO\b|UPDATE\s+[\w"`]+\s+SET\b|DELETE\s+FROM\b)/i;
    const offenders: string[] = [];
    for (const file of walk(join(ROOT, "src/routes"), /\.ts$/)) {
      const r = rel(file);
      if (TRANSITIONAL_SQL_ROUTES.has(r)) continue;
      const text = readFileSync(file, "utf8");
      if (sqlRe.test(text)) offenders.push(r);
    }
    expect(offenders).toEqual([]);
  });

  test("no $fetch / fetch / useApi in pages/components (use composables)", () => {
    const fetchRe = /(?:\$fetch\s*\(|(?<![\w.])fetch\s*\(|useApi\s*\()/;
    const offenders: string[] = [];
    for (const dir of ["web/app/pages", "web/app/components"]) {
      for (const file of walk(join(ROOT, dir), /\.(vue|ts|tsx)$/)) {
        const text = readFileSync(file, "utf8");
        if (fetchRe.test(text)) offenders.push(rel(file));
      }
    }
    expect(offenders).toEqual([]);
  });

  test("whitelist sync — SKILL.md table ↔ CANONICAL_WHITELIST", () => {
    const skill = readFileSync(join(ROOT, ".claude/skills/subbrain-guardrails/SKILL.md"), "utf8");
    const tableRe = /^\|\s*`([^`]+)`(?:\s+\(post[^)]+\))?\s*\|\s*(\d+)(?:\s+each)?\s*\|/gm;
    const docKeys = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = tableRe.exec(skill)) !== null) {
      const path = m[1];
      // Glob `src/mcp/registry/*.tools.ts` is not in CANONICAL_WHITELIST (lives in CANONICAL_GLOB_WHITELIST).
      if (path.includes("*")) continue;
      docKeys.add(path);
    }
    const codeKeys = new Set(Object.keys(CANONICAL_WHITELIST));
    const missingFromCode = [...docKeys].filter((k) => !codeKeys.has(k));
    const missingFromDoc = [...codeKeys].filter((k) => !docKeys.has(k));
    expect(missingFromCode).toEqual([]);
    expect(missingFromDoc).toEqual([]);
  });
});
