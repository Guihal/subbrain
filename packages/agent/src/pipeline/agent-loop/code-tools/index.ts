/**
 * CodeToolRegistry — business façade over `CodeToolsRepository`.
 *
 * Owns size-cap validation (`CODE_TOOL_LIMITS`), boolean cast for `enabled`,
 * and the auto-disable threshold logic. Raw SQL lives in
 * `src/db/tables/code-tools.ts` (guardrail #6 / PR B-2).
 */
import { randomUUID } from "node:crypto";
import type { CodeToolsRepository } from "@subbrain/core/repositories/code-tools.repo";
import type { AgentMode } from "../types";
import { isHiddenInMode } from "./scheduled-blacklist";
import type { CodeTool } from "./types";
import { CODE_TOOL_LIMITS } from "./types";

function hydrate(row: CodeTool | null): CodeTool | null {
  if (!row) return null;
  // sqlite stores bool as 0/1 — surface a real boolean to callers.
  return { ...row, enabled: !!row.enabled };
}

export class CodeToolRegistry {
  constructor(private repo: CodeToolsRepository) {}

  create(name: string, description: string, code: string): CodeTool {
    if (code.length > CODE_TOOL_LIMITS.MAX_CODE_SIZE) {
      throw new Error(`Code exceeds max size: ${code.length} > ${CODE_TOOL_LIMITS.MAX_CODE_SIZE}`);
    }
    const id = randomUUID();
    this.repo.insert(id, name, description, code);
    return hydrate(this.repo.get(id))!;
  }

  get(id: string): CodeTool | null {
    return hydrate(this.repo.get(id));
  }

  getByName(name: string): CodeTool | null {
    return hydrate(this.repo.getByName(name));
  }

  list(includeDisabled = false): CodeTool[] {
    return this.repo.list(includeDisabled).map((r) => ({ ...r, enabled: !!r.enabled }));
  }

  update(name: string, updates: { description?: string; code?: string }): CodeTool {
    const tool = this.getByName(name);
    if (!tool) throw new Error(`Code tool not found: ${name}`);
    if (updates.code && updates.code.length > CODE_TOOL_LIMITS.MAX_CODE_SIZE) {
      throw new Error(`Code exceeds max size`);
    }
    const desc = updates.description ?? tool.description;
    const code = updates.code ?? tool.code;
    this.repo.update(tool.id, desc, code);
    return hydrate(this.repo.get(tool.id))!;
  }

  delete(name: string): boolean {
    return this.repo.delete(name);
  }

  recordRun(name: string, success: boolean, error?: string): void {
    if (success) {
      this.repo.recordSuccess(name);
      return;
    }
    this.repo.recordError(name, error || "Unknown error");
    // Auto-disable if too many errors. Re-fetch so the just-incremented
    // error_count is observed (otherwise the threshold check sees stale data).
    const tool = this.getByName(name);
    if (tool && tool.error_count >= CODE_TOOL_LIMITS.MAX_ERROR_COUNT) {
      this.repo.disable(name);
    }
  }

  /**
   * Convert enabled code tools to OpenAI tool format.
   *
   * F-3b: when `mode === "scheduled"`, code tools listed in
   * `STATEFUL_CLIENT_CODE_TOOLS` are dropped — they embed frozen client
   * snapshots that are unsafe to surface to autonomous loops. Default
   * `"interactive"` keeps backward-compat for any external caller.
   */
  toToolDefs(mode: AgentMode = "interactive"): Array<{
    type: "function";
    function: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    };
  }> {
    return this.list()
      .filter((t) => !isHiddenInMode(t.name, mode))
      .map((t) => ({
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

/** @deprecated Re-exported from plugin; will be removed after A2-9. */
export { applyCodeToolGuards } from "../../../../plugins-internal/code-tool-guards/patterns";
export { executeSandboxed } from "./sandbox";
