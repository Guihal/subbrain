/**
 * F-3b: CodeToolRegistry.toToolDefs(mode) hides STATEFUL_CLIENT_CODE_TOOLS
 * when mode === "scheduled". Default and "interactive" return all tools.
 *
 * See docs/tasks/code-tools-poisoning-fix.md.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { unlinkSync, existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { CodeToolsRepository } from "../src/repositories/code-tools.repo";
import { CodeToolRegistry } from "../src/pipeline/agent-loop/code-tools";
import { migrate } from "../src/db/schema";

const TEST_DB = "data/test-scheduled-filter.db";

function makeRegistry(): CodeToolRegistry {
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  const db = new Database(TEST_DB);
  migrate(db);
  const repo = new CodeToolsRepository(db);
  return new CodeToolRegistry(repo);
}

describe("CodeToolRegistry.toToolDefs mode filter (F-3b)", () => {
  let reg: CodeToolRegistry;
  beforeEach(() => {
    reg = makeRegistry();
    reg.create(
      "overdue_reminder",
      "broken: hardcoded clients",
      "export default async () => 'fake'",
    );
    reg.create(
      "safe_helper",
      "ok",
      "export default async (i) => i.toUpperCase()",
    );
  });
  afterEach(() => {
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  });

  test("interactive returns all enabled tools", () => {
    const names = reg.toToolDefs("interactive").map((t) => t.function.name);
    expect(names).toContain("code_overdue_reminder");
    expect(names).toContain("code_safe_helper");
    expect(names.length).toBe(2);
  });

  test("scheduled hides STATEFUL_CLIENT_CODE_TOOLS, keeps others", () => {
    const names = reg.toToolDefs("scheduled").map((t) => t.function.name);
    expect(names).not.toContain("code_overdue_reminder");
    expect(names).toContain("code_safe_helper");
    expect(names.length).toBe(1);
  });

  test("default (no arg) === interactive (backward-compat)", () => {
    const def = reg.toToolDefs().map((t) => t.function.name);
    const interactive = reg.toToolDefs("interactive").map((t) => t.function.name);
    expect(def).toEqual(interactive);
  });

  test("all 4 stateful client tools blocked together in scheduled mode", () => {
    // Recreate registry with all 4 names.
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    const db = new Database(TEST_DB);
    migrate(db);
    const repo = new CodeToolsRepository(db);
    const r2 = new CodeToolRegistry(repo);
    for (const name of [
      "overdue_reminder",
      "silent_projects_check",
      "critical_clients_monitor",
      "client_followup_check",
    ]) {
      r2.create(name, "stateful", "export default async () => null");
    }
    const names = r2.toToolDefs("scheduled").map((t) => t.function.name);
    expect(names.length).toBe(0);
    db.close();
  });
});
