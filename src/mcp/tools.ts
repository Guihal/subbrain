import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolExecutor } from "./executor";

/**
 * Registers all tools on the MCP server.
 * Each tool delegates to ToolExecutor for actual logic.
 */
export function createMcpServer(executor: ToolExecutor): McpServer {
  const server = new McpServer({
    name: "subbrain",
    version: "0.1.0",
  });

  const text = (data: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
  });

  server.tool(
    "memory_read",
    "Read a memory entry by ID from any layer",
    {
      id: z.string(),
      layer: z.enum(["context", "archive", "shared", "agent"]).optional(),
    },
    async ({ id, layer }) => text(executor.memoryRead(id, layer)),
  );

  server.tool(
    "memory_write",
    "Create or update a memory entry",
    {
      layer: z.enum(["focus", "context", "archive", "shared", "agent"]),
      content: z.string(),
      id: z.string().optional(),
      title: z.string().optional(),
      tags: z.string().optional(),
      category: z.string().optional(),
      agent_id: z.string().optional(),
      confidence: z.enum(["HIGH", "LOW"]).optional(),
      key: z.string().optional(),
    },
    async (params) => text(executor.memoryWrite(params)),
  );

  server.tool(
    "memory_delete",
    "Delete a memory entry by ID",
    {
      id: z.string(),
      layer: z.enum(["context", "archive", "shared", "agent"]),
    },
    async ({ id, layer }) => text(executor.memoryDelete(id, layer)),
  );

  server.tool(
    "memory_search",
    "Hybrid search across memory layers (FTS5 full-text)",
    {
      query: z.string(),
      layer: z.enum(["context", "archive", "shared", "all"]).optional(),
      limit: z.number().optional(),
    },
    async ({ query, layer, limit }) =>
      text(executor.memorySearch(query, layer, limit)),
  );

  server.tool(
    "log_append",
    "Append an entry to the raw log (Layer 4)",
    {
      request_id: z.string(),
      session_id: z.string(),
      agent_id: z.string(),
      role: z.enum(["user", "assistant", "system", "tool"]),
      content: z.string(),
      token_count: z.number().optional(),
    },
    async (p) =>
      text(
        executor.logAppend(
          p.request_id,
          p.session_id,
          p.agent_id,
          p.role,
          p.content,
          p.token_count,
        ),
      ),
  );

  server.tool(
    "log_read",
    "Read raw log entries for a session or request",
    {
      session_id: z.string().optional(),
      request_id: z.string().optional(),
      limit: z.number().optional(),
    },
    async ({ session_id, request_id, limit }) =>
      text(executor.logRead(session_id, request_id, limit)),
  );

  server.tool(
    "embed_text",
    "Generate an embedding for text using NVIDIA embeddings",
    { text: z.string(), model: z.enum(["text", "code"]).optional() },
    async ({ text: t, model }) =>
      text(await executor.embedText(t, model || "text")),
  );

  server.tool(
    "embed_search",
    "Vector similarity search across memory embeddings",
    {
      query: z.string(),
      top_k: z.number().optional(),
      layer: z.string().optional(),
    },
    async ({ query, top_k, layer }) =>
      text(await executor.embedSearch(query, top_k, layer)),
  );

  server.tool(
    "rerank",
    "Rerank passages by relevance to a query",
    {
      query: z.string(),
      passages: z.array(z.string()),
      top_n: z.number().optional(),
    },
    async ({ query, passages, top_n }) =>
      text(await executor.rerank(query, passages, top_n)),
  );

  server.tool(
    "context_summary",
    "Get executive summary of memory context for current session",
    { session_id: z.string() },
    async ({ session_id }) => text(executor.contextSummary(session_id)),
  );

  server.tool(
    "compress_history",
    "Compress chat history into a concise markdown summary",
    {
      messages: z.array(
        z.object({
          role: z.enum(["user", "assistant", "system", "tool"]),
          content: z.string(),
        }),
      ),
    },
    async ({ messages }) => text(await executor.compressHistory(messages)),
  );

  server.tool(
    "rag_search",
    "Hybrid RAG search: FTS5 + vector → RRF merge → rerank. Costs 1-2 RPM.",
    {
      query: z.string(),
      layers: z.array(z.enum(["context", "archive", "shared"])).optional(),
      top_n: z.number().optional(),
      skip_rerank: z.boolean().optional(),
    },
    async ({ query, layers, top_n, skip_rerank }) =>
      text(await executor.ragSearch(query, layers, top_n, skip_rerank)),
  );

  return server;
}
