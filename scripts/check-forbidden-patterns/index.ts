#!/usr/bin/env bun
/**
 * Guardrail: forbidden patterns (KIMI-RAILS-1).
 *
 * Hard ban on typical shortcuts that the compiler lets through but we don't:
 *   - `as any` / `as unknown as X` (type-system bypass)
 *   - `@ts-expect-error` / `@ts-expect-error` without reason
 *   - `// biome-ignore ... <empty>` without reason
 *   - emoji in .ts/.tsx/.vue (except docs / tests fixtures)
 *   - `Promise.all(` on upstream-fetches (see guardrails S2 — must be allSettled)
 *   - `--no-verify` / `--no-gpg-sign` literal in shell-scripts
 *
 * Default: STRICT (exit 1). Set STRICT_FILE_RULES=0 for warn-only.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EMOJI_RE, RULES } from "./rules";
import { isCommentLine, toRel, walk } from "./walker";

const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const SCAN = ["src", "web/app", "web/server", "scripts"];

// Self-exclude: this script's own files should not match themselves.
const SELF_PREFIX = "scripts/check-forbidden-patterns/";

const strict = process.env.STRICT_FILE_RULES !== "0";
type Violation = { file: string; line: number; rule: string; snippet: string; message: string };
const violations: Violation[] = [];

for (const root of SCAN) {
  for (const file of walk(join(ROOT, root))) {
    const rel = toRel(file);
    // Skip our own files to avoid self-reference false positives.
    if (rel.startsWith(SELF_PREFIX)) continue;
    const text = readFileSync(file, "utf8");
    const lines = text.split("\n");

    for (const rule of RULES) {
      if (rule.appliesTo && !rule.appliesTo(rel)) continue;
      lines.forEach((line, i) => {
        if (rule.id !== "ts-ignore" && rule.id !== "ts-nocheck" && isCommentLine(line)) {
          if (rule.id !== "console-in-src" && rule.id !== "no-verify") return;
        }
        if (rule.pattern.test(line)) {
          violations.push({
            file: rel,
            line: i + 1,
            rule: rule.id,
            snippet: line.trim().slice(0, 100),
            message: rule.message,
          });
        }
      });
    }

    if (rel.endsWith(".ts") || rel.endsWith(".tsx") || rel.endsWith(".vue")) {
      lines.forEach((line, i) => {
        if (EMOJI_RE.test(line)) {
          violations.push({
            file: rel,
            line: i + 1,
            rule: "no-emoji",
            snippet: line.trim().slice(0, 100),
            message: "emoji in code prohibited",
          });
        }
      });
    }
  }
}

if (violations.length > 0) {
  console.error(`✗ ${violations.length} forbidden-pattern violation(s):\n`);
  const byRule = new Map<string, Violation[]>();
  for (const v of violations) {
    const arr = byRule.get(v.rule) ?? [];
    arr.push(v);
    byRule.set(v.rule, arr);
  }
  for (const [rule, vs] of byRule) {
    console.error(`  [${rule}] (${vs.length}):`);
    console.error(`    → ${vs[0]?.message ?? ""}`);
    for (const v of vs.slice(0, 8)) {
      console.error(`    ${v.file}:${v.line}  ${v.snippet}`);
    }
    if (vs.length > 8) console.error(`    ... +${vs.length - 8} more`);
    console.error("");
  }
  console.error(
    `Fix: see .claude/skills/kimi-rails/SKILL.md or scripts/check-forbidden-patterns/index.ts.`,
  );
  if (strict) process.exit(1);
  console.error("(STRICT_FILE_RULES=0 — warn-only)");
} else {
  console.log("✓ no forbidden patterns");
}
