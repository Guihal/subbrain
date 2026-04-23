#!/usr/bin/env bun
/**
 * Guardrail #11 lint: real model IDs must live only in `src/lib/model-map.ts`.
 *
 * Scans `src/` for known model-id substrings outside the allowed paths and
 * exits non-zero on hit. Intended for pre-commit / CI.
 *
 * Run: `bun run scripts/check-model-ids.ts`
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SRC = join(ROOT, "src");

const ALLOWED = new Set([
  // Single source of truth.
  join(SRC, "lib/model-map.ts"),
]);

// Substrings that identify real model IDs used in this repo.
const MODEL_ID_PATTERNS: RegExp[] = [
  /\bMiniMax-[A-Za-z0-9.-]+/,
  /\bminimaxai\/[a-z0-9-]+/i,
  /\bmistralai\/[a-z0-9-]+/i,
  /\bmoonshotai\/[a-z0-9-]+/i,
  /\bstepfun-ai\/[a-z0-9-]+/i,
  /\bnvidia\/[a-z0-9-]+/i,
  /\babab[0-9]/,
];

// Allowed-in-comment patterns — commentary referencing a model by name is fine.
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s\/\/.*$/gm, "");
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules") continue;
      out.push(...walk(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

let violations = 0;
for (const file of walk(SRC)) {
  if (ALLOWED.has(file)) continue;
  const stripped = stripComments(readFileSync(file, "utf8"));
  for (const pat of MODEL_ID_PATTERNS) {
    const match = stripped.match(pat);
    if (match) {
      violations++;
      console.error(
        `✗ ${relative(ROOT, file)}: found "${match[0]}" — move to lib/model-map.ts`,
      );
    }
  }
}

if (violations > 0) {
  console.error(
    `\n${violations} model-id violation(s) outside lib/model-map.ts. Guardrail #11.`,
  );
  process.exit(1);
}
console.log("✓ all model IDs live in lib/model-map.ts");
