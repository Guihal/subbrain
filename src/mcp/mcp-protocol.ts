/**
 * Proper MCP JSON-RPC 2.0 transport over HTTP/SSE.
 * Compatible with Continue IDE, Claude Desktop, etc.
 *
 * GET  /mcp/sse      — SSE stream, sends `endpoint` event with full URL
 * POST /mcp/messages — JSON-RPC 2.0 requests (auth-bypassed — route is
 *                      placed BEFORE authMiddleware in index.ts)
 *
 * tools/list и tools/call обслуживаются через единый реестр тулов
 * (src/mcp/registry/), общий с REST и агент-лупом.
 */
import { Elysia, t } from "elysia";
import type { ToolExecutor } from "./executor";
import type { ToolRegistry } from "./registry";

function jsonrpc(id: unknown, result: unknown) {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

function jsonrpcError(id: unknown, code: number, message: string) {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

/**
 * Shared state per SSE session: maps sessionId → response controller.
 */
const sessions = new Map<string, ReadableStreamDefaultController<Uint8Array>>();

export function mcpProtocolRoute(
  registry: ToolRegistry,
  executor: ToolExecutor,
  authToken: string,
) {
  return (
    new Elysia({ prefix: "/mcp" })
      // ── SSE endpoint ──────────────────────────────────────────
      .get("/sse", ({ headers, set, request }) => {
        const auth = headers["authorization"] ?? "";
        if (auth !== `Bearer ${authToken}`) {
          set.status = 401;
          return "Unauthorized";
        }

        const sessionId = crypto.randomUUID();
        const encoder = new TextEncoder();

        const origin = new URL(request.url).origin;
        const messagesUrl = `${origin}/mcp/messages?sessionId=${sessionId}`;

        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            sessions.set(sessionId, controller);

            const endpointEvent = `event: endpoint\ndata: ${messagesUrl}\n\n`;
            controller.enqueue(encoder.encode(endpointEvent));

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
      .post(
        "/messages",
        async ({ body, query, headers, set }) => {
          const auth = headers["authorization"] ?? "";
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
              return new Response(null, { status: 202 });
            } else if (method === "tools/list") {
              response = jsonrpc(id, { tools: registry.listForMcp() });
            } else if (method === "tools/call") {
              const { name, arguments: args } = params as {
                name: string;
                arguments: Record<string, unknown>;
              };

              const result = await registry.call(name, args ?? {}, { executor });
              const text = JSON.stringify(result, null, 2);

              response = jsonrpc(id, {
                content: [{ type: "text", text }],
              });
            } else if (method === "ping") {
              response = jsonrpc(id, {});
            } else {
              response = jsonrpcError(
                id,
                -32601,
                `Method not found: ${method}`,
              );
            }
          } catch (err) {
            response = jsonrpcError(id, -32000, (err as Error).message);
          }

          if (controller) {
            sendSSE(response);
            return new Response(null, { status: 202 });
          }

          return new Response(response, {
            headers: { "Content-Type": "application/json" },
          });
        },
        {
          body: t.Any(),
        },
      )
  );
}
