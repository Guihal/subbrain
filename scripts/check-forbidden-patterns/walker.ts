import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const SKIP_DIRS = new Set([
  "node_modules",
  ".nuxt",
  ".output",
  "dist",
  "build",
  "data",
  "coverage",
]);
const EXT = /\.(ts|tsx|vue|mts|cts|sh)$/;

export function walk(dir: string, out: string[] = []): string[] {
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

export function toRel(abs: string): string {
  return relative(ROOT, abs).split(sep).join("/");
}

export function isCommentLine(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}
