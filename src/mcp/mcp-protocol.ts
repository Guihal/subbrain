/**
 * Proper MCP JSON-RPC 2.0 transport over HTTP/SSE
 * Compatible with Continue IDE, Claude Desktop, etc.
 *
 * GET  /mcp/sse      — SSE stream, sends `endpoint` event
 * POST /mcp/messages — JSON-RPC 2.0 requests
 */
import { Elysia, t } from "elysia";
import type { ToolExecutor } from "./executor";

const MCP_TOOLS = [
  {
    name: "memory_search",
    description: "Гибридный поиск по памяти (FTS5 + vector). Ищи факты о пользователе, проектах, контексте.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Поисковый запрос" },
        layer: { type: "string", enum: ["context", "archive", "shared"], description: "Слой памяти (опционально)" },
        limit: { type: "number", description: "Макс. результатов (default: 10)" },
      },
      required: ["query"],
    },
  },
  {
    name: "memory_write",
    description: "Сохранить факт или контекст в память (layer 2 = context).",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "Markdown-контент для сохранения" },
        layer: { type: "number", enum: [2, 3], description: "2=context, 3=archive (default: 2)" },
        tags: { type: "string", description: "Теги через запятую" },
      },
      required: ["content"],
    },
  },
  {
    name: "memory_read",
    description: "Прочитать запись памяти по ID.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
      },
      required: ["id"],
    },
  },
  {
    name: "rag_search",
    description: "RAG поиск: FTS5 + embeddings + rerank. Точнее чем memory_search.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        layers: {
          type: "array",
          items: { type: "string", enum: ["context", "archive", "shared"] },
        },
        top_n: { type: "number" },
      },
      required: ["query"],
    },
  },
  {
    name: "tg_list_chats",
    description: "Список Telegram-чатов пользователя.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number" },
      },
    },
  },
  {
    name: "tg_read_chat",
    description: "Прочитать сообщения из Telegram-чата.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string" },
        limit: { type: "number" },
      },
      required: ["chat_id"],
    },
  },
  {
    name: "tg_send_message",
    description: "Отправить сообщение владельцу через Telegram-бот.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
      },
      required: ["text"],
    },
  },
  {
    name: "web_navigate",
    description: "Открыть URL в браузере, получить содержимое страницы.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
      },
      required: ["url"],
    },
  },
];

async function callTool(
  executor: ToolExecutor,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "memory_search":
      return executor.memorySearch(
        args.query as string,
        args.layer as string | undefined,
        args.limit as number | undefined,
      );
    case "memory_write":
      return executor.memoryWrite(args as any);
    case "memory_read":
      return executor.memoryRead(args.id as string);
    case "rag_search":
      return executor.ragSearch(
        args.query as string,
        args.layers as any,
        args.top_n as number | undefined,
      );
    case "tg_list_chats":
      return executor.tgListChats(args.limit as number | undefined);
    case "tg_read_chat":
      return executor.tgReadChat(
        args.chat_id as string,
        args.limit as number | undefined,
      );
    case "tg_send_message":
      return executor.tgSendMessage(args.text as string);
    case "web_navigate":
      return executor.webCallTool("browser_navigate", { url: args.url });
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function jsonrpc(id: unknown, result: unknown) {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

function jsonrpcError(id: unknown, code: number, message: string) {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

/**
 * Shared state per SSE session: maps sessionId → response controller
 */
const sessions = new Map<string, ReadableStreamDefaultController<Uint8Array>>();

export function mcpProtocolRoute(executor: ToolExecutor, authToken: string) {
  return new Elysia({ prefix: "/mcp" })
    // ── SSE endpoint ──────────────────────────────────────────
    .get("/sse", ({ headers, set }) => {
      // Simple auth check
      const auth = headers["authorization"] || headers["Authorization"] || "";
      if (auth !== `Bearer ${authToken}`) {
        set.status = 401;
        return "Unauthorized";
      }

      const sessionId = crypto.randomUUID();
      const encoder = new TextEncoder();

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          sessions.set(sessionId, controller);

          // Send endpoint event — tells client where to POST messages
          const endpointEvent = `event: endpoint\ndata: /mcp/messages?sessionId=${sessionId}\n\n`;
          controller.enqueue(encoder.encode(endpointEvent));

          // Keepalive ping every 25s
          const ping = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(": ping\n\n"));
            } catch {
              clearInterval(ping);
            }
          }, 25_000);
        },
        cancel() {
          sessions.delete(sessionId);
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          "X-Accel-Buffering": "no",
          "Content-Encoding": "identity",
        },
      });
    })
    // ── JSON-RPC messages endpoint ────────────────────────────
    .post("/messages", async ({ body, query, headers, set }) => {
      const auth = headers["authorization"] || headers["Authorization"] || "";
      if (auth !== `Bearer ${authToken}`) {
        set.status = 401;
        return "Unauthorized";
      }

      const sessionId = query?.sessionId as string | undefined;
      const controller = sessionId ? sessions.get(sessionId) : undefined;
      const encoder = new TextEncoder();

      const sendSSE = (data: string) => {
        if (controller) {
          try {
            controller.enqueue(encoder.encode(`data: ${data}\n\n`));
          } catch {}
        }
      };

      const msg = body as any;
      const { jsonrpc: _jv, id, method, params } = msg;

      let response: string;

      try {
        if (method === "initialize") {
          response = jsonrpc(id, {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "subbrain", version: "1.0.0" },
          });
        } else if (method === "notifications/initialized") {
          // No response needed for notifications
          return new Response(null, { status: 202 });
        } else if (method === "tools/list") {
          response = jsonrpc(id, { tools: MCP_TOOLS });
        } else if (method === "tools/call") {
          const { name, arguments: args } = params as {
            name: string;
            arguments: Record<string, unknown>;
          };

          const result = await callTool(executor, name, args ?? {});
          const text =
            typeof result === "string" ? result : JSON.stringify(result, null, 2);

          response = jsonrpc(id, {
            content: [{ type: "text", text }],
          });
        } else if (method === "ping") {
          response = jsonrpc(id, {});
        } else {
          response = jsonrpcError(id, -32601, `Method not found: ${method}`);
        }
      } catch (err) {
        response = jsonrpcError(id, -32000, (err as Error).message);
      }

      // Send via SSE if session exists, otherwise return directly
      if (controller) {
        sendSSE(response);
        return new Response(null, { status: 202 });
      }

      return new Response(response, {
        headers: { "Content-Type": "application/json" },
      });
    });
}