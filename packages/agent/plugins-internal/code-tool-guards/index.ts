/**
 * @subbrain/plugin-code-tool-guards
 *
 * Plugin that registers tool.execute.before hooks on create_code_tool
 * and edit_code_tool. Replaces inline applyCodeToolGuards calls.
 *
 * Defense-in-depth: same regex patterns, same thresholds, same error
 * strings as the original inline validators.
 */
import type { Plugin, ToolResult } from "@subbrain/plugin";
import { applyCodeToolGuards, type GuardLog } from "./patterns";

interface ToolArgs {
  name?: string;
  code?: string;
}

interface Ctx {
  log?: GuardLog;
}

export const codeToolGuardsPlugin: Plugin = {
  name: "@subbrain/plugin-code-tool-guards",
  setup({ hooks }) {
    hooks.onToolBefore(async ({ toolName, args, ctx }) => {
      if (toolName !== "create_code_tool" && toolName !== "edit_code_tool") {
        return undefined;
      }
      const a = args as ToolArgs;
      const code = a.code;
      if (typeof code !== "string") {
        return undefined;
      }
      const name = a.name || "(unnamed)";
      const log = (ctx as Ctx)?.log;
      if (!log) {
        return undefined;
      }
      const guardErr = applyCodeToolGuards(code, name, log);
      if (guardErr) {
        return {
          kind: "rejected" as const,
          error: {
            code: guardErr.error.startsWith("sandbox_violation")
              ? "sandbox_violation"
              : "hardcoded_facts",
            message: guardErr.error,
          },
        } as ToolResult;
      }
      return undefined;
    });
  },
};
