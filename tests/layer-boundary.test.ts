/**
 * Layer-boundary guardrail (PR 27).
 *
 * Raw SQL must only live in `src/db/tables/` and `src/repositories/`. Any
 * leak into `src/services/`, `src/routes/`, or `src/pipeline/` short-
 * circuits the repository abstraction and re-opens the god-object pattern
 * PR 27 just closed.
 *
 * How it works:
 *   - Regex scan: word-boundary + uppercase SQL verb + whitespace. Matches
 *     actual statements (`SELECT *`, `INSERT INTO ...`, `.query("SELECT ...")`)
 *     but NOT casual English ("insert", "update the doc"). Case-sensitive on
 *     purpose — we only care about code, not comments.
 *   - Comment scrubbing: `//`, `/* … *\/`, and JSDoc blocks stripped before
 *     matching so prose in docstrings doesn't count.
 *   - Known legacy offenders live on an allow-list (`KNOWN_LEGACY`). New
 *     files in forbidden dirs must come in clean; the list only shrinks.
 *
 * The test has two modes: a strict sweep of unlisted files (must be empty),
 * and a smoke check against a synthetic injection (proves the grep works).
 */
import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative, sep } from "path";

const REPO_ROOT = join(import.meta.dir, "..");
const FORBIDDEN = [
  join("src", "services"),
  join("src", "routes"),
  join("src", "pipeline"),
];

/**
 * Files that predate PR 27 and still issue raw SQL. Migrating them is
 * tracked in follow-up PRs (see `docs/tasks/refactor/` backlog). Do NOT
 * extend this list to silence a new violation — fix the call-site through
 * a repository instead.
 */
const KNOWN_LEGACY = new Set<string>([
  // W2-1 (2026-04-28) — pruned: src/routes/logs.ts SQL → LogRepository methods.
  // W2-2 (2026-04-28) — pruned: src/routes/tasks.ts SQL → TaskRepository.
  // PR B-2 (2026-04-25) — pruned: agent-loop/persist.ts + agent-loop/code-tools/index.ts
  // migrated to src/db/tables/code-tools.ts + src/repositories/code-tools.repo.ts
  // and the agent_memory blob round-trip via SharedTable methods.
  "src/pipeline/night-cycle/prune/tasks.ts",
  "src/pipeline/night-cycle/prune/stray-tasks/fetch.ts",
  "src/pipeline/night-cycle/steps/contradictions.ts",
]);

const SQL_VERB_RE = /\b(INSERT|UPDATE|DELETE|SELECT)\s/;

function stripComments(src: string): string {
  // Block comments (including JSDoc). Non-greedy over newlines.
  let out = src.replace(/\/\*[\s\S]*?\*\//g, "");
  // Line comments (whole-line or trailing).
  out = out.replace(/\/\/[^\n]*/g, "");
  return out;
}

function listTsFiles(dir: string): string[] {
  const abs = join(REPO_ROOT, dir);
  let entries: string[] = [];
  try {
    entries = readdirSync(abs);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    const full = join(abs, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listTsFiles(join(dir, name)));
    } else if (name.endsWith(".ts")) {
      out.push(join(dir, name));
    }
  }
  return out;
}

function toPosix(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}

function findRawSql(file: string): number | null {
  const abs = join(REPO_ROOT, file);
  const raw = readFileSync(abs, "utf8");
  const scrubbed = stripComments(raw);
  // Match with line context so a future fail points at the offending line.
  const lines = scrubbed.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (SQL_VERB_RE.test(lines[i])) return i + 1;
  }
  return null;
}

describe("layer-boundary — raw SQL in services/routes/pipeline", () => {
  test("no raw SQL outside db/tables/ + repositories/ (except legacy allow-list)", () => {
    const offenders: string[] = [];
    for (const dir of FORBIDDEN) {
      for (const f of listTsFiles(dir)) {
        const posix = toPosix(f);
        if (KNOWN_LEGACY.has(posix)) continue;
        const hit = findRawSql(f);
        if (hit !== null) offenders.push(`${posix}:${hit}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("legacy allow-list still hits (sanity — otherwise prune it)", () => {
    const stale: string[] = [];
    for (const posix of KNOWN_LEGACY) {
      // Convert posix → OS-native for fs read.
      const osPath = sep === "/" ? posix : posix.split("/").join(sep);
      try {
        const hit = findRawSql(osPath);
        if (hit === null) stale.push(posix);
      } catch {
        stale.push(posix); // missing file also stale
      }
    }
    expect(stale).toEqual([]);
  });

  test("regex catches a synthetic INSERT INTO in a service file (grep proven)", () => {
    const synthetic = `
      export class Evil {
        bad() {
          this.db.query("INSERT INTO shared_memory (id) VALUES (?)").run("x");
        }
      }
    `;
    expect(SQL_VERB_RE.test(stripComments(synthetic))).toBe(true);
  });

  test("regex ignores comments and casual prose", () => {
    const benign = `
      // You might want to insert a row here
      /** TODO: select best candidate */
      export const x = "noop";
    `;
    expect(SQL_VERB_RE.test(stripComments(benign))).toBe(false);
  });

  test("regex ignores lowercase casual English verbs", () => {
    // In-method code calling .insert or .update (repo methods) is legal.
    const legal = `
      this.repo.insertShared(id, cat, content);
      this.repo.updateShared(id, { tags: "x" });
    `;
    expect(SQL_VERB_RE.test(stripComments(legal))).toBe(false);
  });
});
