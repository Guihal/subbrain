import { Elysia, t } from "elysia";
import type { ToolExecutor } from "./executor";

/**
 * Exposes tools as REST endpoints for internal agent pipeline use.
 *
 * POST /mcp/tools/list   — list available tools
 * POST /mcp/tools/call   — call a tool by name { name, arguments }
 */
export function mcpRoute(executor: ToolExecutor) {
  const TOOL_LIST = [
    { name: "memory_read", description: "Read a memory entry by ID" },
    { name: "memory_write", description: "Create or update a memory entry" },
    { name: "memory_delete", description: "Delete a memory entry by ID" },
    { name: "memory_search", description: "Hybrid FTS5 search across memory" },
    { name: "log_append", description: "Append to raw log (Layer 4)" },
    { name: "log_read", description: "Read logs by session/request" },
    { name: "embed_text", description: "Generate text embedding" },
    { name: "embed_search", description: "Vector similarity search" },
    { name: "rerank", description: "Rerank passages by relevance" },
    { name: "context_summary", description: "Get session context summary" },
    {
      name: "compress_history",
      description: "Compress chat history to summary",
    },
    {
      name: "rag_search",
      description: "Hybrid RAG search: FTS5 + vector → RRF → rerank",
    },
    { name: "tg_send_message", description: "Send message to user via Telegram" },
    { name: "web_navigate", description: "Navigate browser to URL, return page content" },
    { name: "web_snapshot", description: "Get current page content" },
    { name: "web_click", description: "Click element on page by ref number" },
    { name: "web_type", description: "Type text into input field" },
    { name: "web_back", description: "Go back in browser history" },
    { name: "web_press_key", description: "Press keyboard key in browser" },
  ];

  return new Elysia({ prefix: "/mcp" })
    .post("/tools/list", () => ({ tools: TOOL_LIST }))
    .post("/tools/call", async ({ body }: { body: any }) => {
      const { name, arguments: args } = body as {
        name: string;
        arguments: Record<string, unknown>;
      };

      try {
        switch (name) {
          case "memory_read":
            return executor.memoryRead(
              args.id as string,
              args.layer as string | undefined,
            );
          case "memory_write":
            return executor.memoryWrite(args as any);
          case "memory_delete":
            return executor.memoryDelete(
              args.id as string,
              args.layer as string,
            );
          case "memory_search":
            return executor.memorySearch(
              args.query as string,
              args.layer as string | undefined,
              args.limit as number | undefined,
            );
          case "log_append":
            return executor.logAppend(
              args.request_id as string,
              args.session_id as string,
              args.agent_id as string,
              args.role as string,
              args.content as string,
              args.token_count as number | undefined,
            );
          case "log_read":
            return executor.logRead(
              args.session_id as string | undefined,
              args.request_id as string | undefined,
              args.limit as number | undefined,
            );
          case "embed_text":
            return await executor.embedText(
              args.text as string,
              (args.model as "text" | "code") || "text",
            );
          case "embed_search":
            return await executor.embedSearch(
              args.query as string,
              args.top_k as number | undefined,
              args.layer as string | undefined,
            );
          case "rerank":
            return await executor.rerank(
              args.query as string,
              args.passages as string[],
              args.top_n as number | undefined,
            );
          case "context_summary":
            return executor.contextSummary(args.session_id as string);
          case "compress_history":
            return await executor.compressHistory(args.messages as any);
          case "rag_search":
            return await executor.ragSearch(
              args.query as string,
              args.layers as ("context" | "archive" | "shared")[] | undefined,
              args.top_n as number | undefined,
              args.skip_rerank as boolean | undefined,
            );
          case "tg_send_message":
            return await executor.tgSendMessage(args.text as string);
          case "web_navigate":
            return { success: true, data: await executor.webCallTool("browser_navigate", { url: args.url }) };
          case "web_snapshot":
            return { success: true, data: await executor.webCallTool("browser_snapshot", {}) };
          case "web_click":
            return { success: true, data: await executor.webCallTool("browser_click", { element: args.element, ref: args.ref }) };
          case "web_type":
            return { success: true, data: await executor.webCallTool("browser_type", { element: args.element, ref: args.ref, text: args.text, ...(args.submit ? { submit: true } : {}) }) };
          case "web_back":
            return { success: true, data: await executor.webCallTool("browser_go_back", {}) };
          case "web_press_key":
            return { success: true, data: await executor.webCallTool("browser_press_key", { key: args.key }) };
          default:
            return new Response(
              JSON.stringify({
                success: false,
                error: `Unknown tool: ${name}`,
              }),
              { status: 404, headers: { "Content-Type": "application/json" } },
            );
        }
      } catch (err) {
        return new Response(
          JSON.stringify({ success: false, error: (err as Error).message }),
          { status: 500, headers: { "Content-Type": "application/json" } },
        );
      }
    });
}
