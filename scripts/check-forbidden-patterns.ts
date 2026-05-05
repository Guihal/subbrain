/**
 * Guardrail: forbid dangerous patterns in source code.
 * Exit 0 = clean, exit 1 = violations found.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const STRICT = process.env.STRICT_FILE_RULES === "1";

interface Rule {
  name: string;
  pattern: RegExp;
  paths: string[]; // glob-ish prefixes to scan
  severity: "error" | "warn";
  message: string;
}

const consoleAllowlist = new Set([
  "src/lib/logger.ts",
  "src/app/deps.ts",
  "src/providers/index.ts",
]);

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
      .map((d) => `packages/${d}/src/`);
  } catch {
    return [];
  }
}

const rules: Rule[] = [
  {
    name: "no-console-in-src",
    pattern: /\bconsole\.(log|warn|error|info)\s*\(/,
    paths: ["src/", ...globPackagesSrc()],
    severity: STRICT ? "error" : "warn",
    message: "Use logger.* instead of console.*",
  },
  {
    name: "no-raw-sql-in-routes",
    pattern: /\b(SELECT|INSERT\s+INTO|UPDATE\s+.*SET|DELETE\s+FROM)\b/i,
    paths: ["src/routes/", "src/app/", "packages/server/src/routes/", "packages/server/src/app/"],
    severity: "error",
    message: "Raw SQL must not appear in routes or app layer",
  },
  {
    name: "no-process-env-in-views",
    pattern: /process\.env\b/,
    paths: ["web/app/"],
    severity: "error",
    message: "Use useRuntimeConfig() instead of process.env in Vue/Nuxt",
  },
];

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const st = statSync(path);
    if (st.isDirectory()) {
      yield* walk(path);
    } else if (st.isFile() && /\.(ts|tsx|vue)$/.test(path)) {
      yield path;
    }
  }
}

let errors = 0;
let warnings = 0;

for (const rule of rules) {
  for (const prefix of rule.paths) {
    const dir = join(ROOT, prefix);
    if (!existsSync(dir)) continue;
    for (const path of walk(dir)) {
      const rel = path.replace(ROOT + "/", "");
      const text = readFileSync(path, "utf-8");
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (rule.pattern.test(line)) {
          // Skip comments and allowlisted files
          const trimmed = line.trim();
          if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
          if (rule.name === "no-console-in-src" && consoleAllowlist.has(rel)) continue;
          const msg = `[${rule.name}] ${rel}:${i + 1} — ${rule.message}`;
          if (rule.severity === "error") {
            console.error(msg);
            errors++;
          } else {
            console.warn(msg);
            warnings++;
          }
        }
      }
    }
  }
}

if (warnings > 0) {
  console.warn(`\n${warnings} warning(s)`);
}
if (errors > 0) {
  console.error(`\n${errors} error(s)`);
  process.exit(1);
}
console.log("check-forbidden-patterns: clean");
