import { Elysia } from "elysia";
import type { ToolExecutor } from "@subbrain/agent/mcp/executor";
import type { ToolRegistry } from "@subbrain/agent/mcp/registry";

/**
 * Exposes tools as REST endpoints for internal agent pipeline use.
 *
 * POST /mcp/tools/list   — list available tools (public scope only)
 * POST /mcp/tools/call   — call a tool by name { name, arguments }
 *
 * Dispatch идёт через единый реестр (src/mcp/registry/), никаких
 * switch-case: добавил тул в реестр → работает во всех транспортах.
 */
export function mcpRoute(registry: ToolRegistry, executor: ToolExecutor) {
  return new Elysia({ prefix: "/mcp" })
    .post("/tools/list", () => ({ tools: registry.listPublic() }))
    .post("/tools/call", async ({ body }: { body: any }) => {
      const { name, arguments: args } = body as {
        name: string;
        arguments: Record<string, unknown>;
      };

      if (!registry.has(name)) {
        return new Response(
          JSON.stringify({
            success: false,
            error: `Unknown tool: ${name}`,
          }),
          { status: 404, headers: { "Content-Type": "application/json" } },
        );
      }

      const result = await registry.callAsPublic(name, args ?? {}, {
        executor,
        agentId: null, // REST = admin scope; B-1 isolation lives in agent-loop ctx
      });
      return result;
    });
}
