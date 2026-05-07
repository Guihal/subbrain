/**
 * Code-tool management (agent-only).
 * CRUD + test для пользовательских code-тулов, исполняемых в sandbox.
 */

import { executeSandboxed } from "../../pipeline/agent-loop/code-tools";
import { type ToolRegistry, t } from "./tool-registry";

export function registerCodeMgmtTools(registry: ToolRegistry): void {
  registry.register({
    name: "create_code_tool",
    description:
      "Create a new executable code tool. Code must be a TS module exporting a default async function: `export default async (input: string) => { return 'result'; }`. Has fetch(). Max 10KB.",
    scope: "agent-only",
    input: t.Object({
      name: t.String({
        description: "Tool name (snake_case). Callable as code_<name>.",
      }),
      description: t.String(),
      code: t.String({
        description: "TypeScript: export default async (input: string) => string|object",
      }),
    }),
    handler: (args, ctx) => {
      if (!ctx.codeTools) {
        return { success: false, error: "Code tools not available" };
      }
      try {
        const tool = ctx.codeTools.create(args.name, args.description, args.code);
        ctx.log.info("agent-loop", `Code tool created: ${tool.name}`);
        return { success: true, data: { name: tool.name, id: tool.id } };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, error: msg };
      }
    },
  });

  registry.register({
    name: "edit_code_tool",
    description: "Edit an existing code tool's code or description.",
    scope: "agent-only",
    input: t.Object({
      name: t.String(),
      code: t.Optional(t.String()),
      description: t.Optional(t.String()),
    }),
    handler: (args, ctx) => {
      if (!ctx.codeTools) {
        return { success: false, error: "Code tools not available" };
      }
      try {
        const tool = ctx.codeTools.update(args.name, {
          code: args.code,
          description: args.description,
        });
        ctx.log.info("agent-loop", `Code tool updated: ${tool.name}`);
        return { success: true, data: { name: tool.name } };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, error: msg };
      }
    },
  });

  registry.register({
    name: "delete_code_tool",
    description: "Delete a code tool by name.",
    scope: "agent-only",
    input: t.Object({ name: t.String() }),
    handler: (args, ctx) => {
      if (!ctx.codeTools) {
        return { success: false, error: "Code tools not available" };
      }
      const deleted = ctx.codeTools.delete(args.name);
      ctx.log.info("agent-loop", `Code tool deleted: ${args.name} (${deleted})`);
      return { success: deleted };
    },
  });

  registry.register({
    name: "test_code_tool",
    description: "Test a code tool with sample input. Returns output or error.",
    scope: "agent-only",
    input: t.Object({
      name: t.String(),
      input: t.String(),
    }),
    handler: async (args, ctx) => {
      if (!ctx.codeTools) {
        return { success: false, error: "Code tools not available" };
      }
      const tool = ctx.codeTools.getByName(args.name);
      if (!tool) return { success: false, error: `Tool not found: ${args.name}` };

      ctx.log.info("agent-loop", `Testing code tool: ${tool.name}`);
      const result = await executeSandboxed(tool.code, args.input);
      ctx.codeTools.recordRun(tool.name, result.success, result.error);
      return result.success
        ? { success: true, data: result.output }
        : { success: false, error: result.error };
    },
  });

  registry.register({
    name: "list_code_tools",
    description: "List all code tools with their status, run count, and error count.",
    scope: "agent-only",
    input: t.Object({
      include_disabled: t.Optional(t.Boolean()),
    }),
    handler: (args, ctx) => {
      if (!ctx.codeTools) {
        return { success: false, error: "Code tools not available" };
      }
      const tools = ctx.codeTools.list(!!args.include_disabled);
      return {
        success: true,
        data: tools.map((t) => ({
          name: t.name,
          description: t.description,
          enabled: t.enabled,
          run_count: t.run_count,
          error_count: t.error_count,
          last_run_at: t.last_run_at,
        })),
      };
    },
  });
}
