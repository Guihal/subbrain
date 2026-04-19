/**
 * CodeToolRegistry — CRUD operations for code tools stored in SQLite.
 */
import { randomUUID } from "crypto";
import type { Database } from "bun:sqlite";
import type { CodeTool } from "./types";
import { CODE_TOOL_LIMITS } from "./types";

export class CodeToolRegistry {
  constructor(private db: Database) {}

  create(name: string, description: string, code: string): CodeTool {
    if (code.length > CODE_TOOL_LIMITS.MAX_CODE_SIZE) {
      throw new Error(
        `Code exceeds max size: ${code.length} > ${CODE_TOOL_LIMITS.MAX_CODE_SIZE}`,
      );
    }

    const id = randomUUID();
    this.db.run(
      `INSERT INTO code_tools (id, name, description, code) VALUES (?, ?, ?, ?)`,
      [id, name, description, code],
    );

    return this.get(id)!;
  }

  get(id: string): CodeTool | null {
    const row = this.db
      .query(`SELECT * FROM code_tools WHERE id = ?`)
      .get(id) as CodeTool | null;
    if (row) row.enabled = !!row.enabled;
    return row;
  }

  getByName(name: string): CodeTool | null {
    const row = this.db
      .query(`SELECT * FROM code_tools WHERE name = ?`)
      .get(name) as CodeTool | null;
    if (row) row.enabled = !!row.enabled;
    return row;
  }

  list(includeDisabled = false): CodeTool[] {
    const sql = includeDisabled
      ? `SELECT * FROM code_tools ORDER BY updated_at DESC`
      : `SELECT * FROM code_tools WHERE enabled = 1 ORDER BY updated_at DESC`;
    const rows = this.db.query(sql).all() as CodeTool[];
    return rows.map((r) => ({ ...r, enabled: !!r.enabled }));
  }

  update(
    name: string,
    updates: { description?: string; code?: string },
  ): CodeTool {
    const tool = this.getByName(name);
    if (!tool) throw new Error(`Code tool not found: ${name}`);

    if (updates.code && updates.code.length > CODE_TOOL_LIMITS.MAX_CODE_SIZE) {
      throw new Error(`Code exceeds max size`);
    }

    const desc = updates.description ?? tool.description;
    const code = updates.code ?? tool.code;

    this.db.run(
      `UPDATE code_tools SET description = ?, code = ?, error_count = 0, enabled = 1, updated_at = unixepoch() WHERE id = ?`,
      [desc, code, tool.id],
    );

    return this.get(tool.id)!;
  }

  delete(name: string): boolean {
    const result = this.db.run(`DELETE FROM code_tools WHERE name = ?`, [name]);
    return result.changes > 0;
  }

  recordRun(name: string, success: boolean, error?: string): void {
    if (success) {
      this.db.run(
        `UPDATE code_tools SET run_count = run_count + 1, last_run_at = unixepoch(), updated_at = unixepoch() WHERE name = ?`,
        [name],
      );
    } else {
      this.db.run(
        `UPDATE code_tools SET run_count = run_count + 1, error_count = error_count + 1, last_run_at = unixepoch(), last_error = ?, updated_at = unixepoch() WHERE name = ?`,
        [error || "Unknown error", name],
      );

      // Auto-disable if too many errors
      const tool = this.getByName(name);
      if (tool && tool.error_count >= CODE_TOOL_LIMITS.MAX_ERROR_COUNT) {
        this.db.run(
          `UPDATE code_tools SET enabled = 0, updated_at = unixepoch() WHERE name = ?`,
          [name],
        );
      }
    }
  }

  /** Convert enabled code tools to OpenAI tool format */
  toToolDefs(): Array<{
    type: "function";
    function: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    };
  }> {
    return this.list().map((t) => ({
      type: "function" as const,
      function: {
        name: `code_${t.name}`,
        description: `[Code Tool] ${t.description}`,
        parameters: {
          type: "object",
          properties: {
            input: {
              type: "string",
              description: "Input data for the tool (text, JSON, URL, etc.)",
            },
          },
          required: ["input"],
        } as Record<string, unknown>,
      },
    }));
  }
}
