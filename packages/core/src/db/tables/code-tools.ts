/**
 * `code_tools` table — sandboxed agent-authored code modules.
 *
 * Owned by `CodeToolRegistry` (pipeline/agent-loop/code-tools); SQL stays
 * here per PR 27 layer-boundary rule. Auto-disable threshold + boolean cast
 * for `enabled` (sqlite stores 0/1) live in the registry, not in the table.
 */
import type { Database } from "bun:sqlite";
import type { CodeTool } from "@subbrain/core/types/code-tool";

export class CodeToolsTable {
  constructor(private db: Database) {}

  insert(id: string, name: string, description: string, code: string): void {
    this.db
      .query("INSERT INTO code_tools (id, name, description, code) VALUES (?, ?, ?, ?)")
      .run(id, name, description, code);
  }

  get(id: string): CodeTool | null {
    return this.db.query("SELECT * FROM code_tools WHERE id = ?").get(id) as CodeTool | null;
  }

  getByName(name: string): CodeTool | null {
    return this.db.query("SELECT * FROM code_tools WHERE name = ?").get(name) as CodeTool | null;
  }

  list(includeDisabled = false): CodeTool[] {
    const sql = includeDisabled
      ? "SELECT * FROM code_tools ORDER BY updated_at DESC"
      : "SELECT * FROM code_tools WHERE enabled = 1 ORDER BY updated_at DESC";
    return this.db.query(sql).all() as CodeTool[];
  }

  /** Updates description+code, resets error_count, re-enables. */
  update(id: string, description: string, code: string): void {
    this.db
      .query(
        "UPDATE code_tools SET description = ?, code = ?, error_count = 0, enabled = 1, updated_at = unixepoch() WHERE id = ?",
      )
      .run(description, code, id);
  }

  delete(name: string): boolean {
    const result = this.db.query("DELETE FROM code_tools WHERE name = ?").run(name);
    return result.changes > 0;
  }

  recordSuccess(name: string): void {
    this.db
      .query(
        "UPDATE code_tools SET run_count = run_count + 1, last_run_at = unixepoch(), updated_at = unixepoch() WHERE name = ?",
      )
      .run(name);
  }

  recordError(name: string, errorMsg: string): void {
    this.db
      .query(
        "UPDATE code_tools SET run_count = run_count + 1, error_count = error_count + 1, last_run_at = unixepoch(), last_error = ?, updated_at = unixepoch() WHERE name = ?",
      )
      .run(errorMsg, name);
  }

  disable(name: string): void {
    this.db
      .query("UPDATE code_tools SET enabled = 0, updated_at = unixepoch() WHERE name = ?")
      .run(name);
  }
}
