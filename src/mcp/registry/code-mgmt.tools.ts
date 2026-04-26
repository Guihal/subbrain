/**
 * Code-tool management (agent-only).
 * CRUD + test для пользовательских code-тулов, исполняемых в sandbox.
 */
import { t, type ToolRegistry } from "./tool-registry";
import { executeSandboxed } from "../../pipeline/agent-loop/code-tools/sandbox";

// Sandbox = Bun Worker with require/process/Function nulled and dynamic
// import() blocked. Static imports of any kind also break (Function-body is
// non-module-context — parser reads `import` as dynamic-call). Reject these
// patterns at registration/edit time so the agent gets immediate feedback
// instead of polluting hippocampus extraction with runtime errors.
// `import type` is type-only and erased by transpiler — allowed via lookahead.
const SANDBOX_FORBIDDEN: Array<{ re: RegExp; hint: string }> = [
  { re: /\brequire\s*\(/, hint: "require() blocked in sandbox; use fetch() to /v1/* HTTP endpoints" },
  { re: /^\s*import\s+(?!type\b)/m, hint: "static `import` (any form) breaks in sandbox Function-context; use fetch()-based pattern" },
  { re: /\bfrom\s+["']node:/, hint: "node:* imports unavailable in sandbox; use fetch() to internal /v1/* endpoints" },
  { re: /\bimport\s*\(\s*["']node:/, hint: "node:* imports unavailable in sandbox; dynamic import() is also blocked at runtime" },
  { re: /\bfrom\s+["']child_process["']/, hint: "child_process unavailable; no shell access in sandbox" },
];

function checkSandboxCompat(code: string): { ok: true } | { ok: false; hint: string } {
  for (const { re, hint } of SANDBOX_FORBIDDEN) {
    if (re.test(code)) return { ok: false, hint };
  }
  return { ok: true };
}

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
        description:
          "TypeScript: export default async (input: string) => string|object",
      }),
    }),
    handler: (args, ctx) => {
      if (!ctx.codeTools) {
        return { success: false, error: "Code tools not available" };
      }
      const guard = checkSandboxCompat(args.code);
      if (!guard.ok) {
        return { success: false, error: `sandbox_violation: ${guard.hint}` };
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
      if (typeof args.code === "string") {
        const guard = checkSandboxCompat(args.code);
        if (!guard.ok) {
          return { success: false, error: `sandbox_violation: ${guard.hint}` };
        }
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
      ctx.log.info(
        "agent-loop",
        `Code tool deleted: ${args.name} (${deleted})`,
      );
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
    description:
      "List all code tools with their status, run count, and error count.",
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
