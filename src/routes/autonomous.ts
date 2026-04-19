import { Elysia, t } from "elysia";
import type { AgentLoop } from "../pipeline/agent-loop";
import type { MemoryDB } from "../db";

export function autonomousRoute(agentLoop: AgentLoop, memory?: MemoryDB) {
  return new Elysia().post(
    "/v1/autonomous",
    async ({ body, headers }) => {
      const stream = body.stream ?? false;
      const sessionId =
        (headers["x-session-id"] as string | undefined) || undefined;
      const chatId = (headers["x-chat-id"] as string | undefined) || sessionId;
      const source = (headers["x-chat-source"] as string) || (sessionId ? "web" : "autonomous");
      const model = body.model || "teamlead";

      // Persist chat immediately (don't wait for agent loop to finish)
      if (memory && chatId) {
        const existing = memory.getChat(chatId);
        if (!existing) {
          memory.createChat(chatId, body.task.slice(0, 80), model, source);
        } else if (existing.model !== model) {
          memory.updateChatModel(chatId, model);
        }
        memory.appendChatMessage(chatId, "user", body.task);
      }

      const req = {
        task: body.task,
        model,
        maxSteps: body.max_steps,
        sessionId,
      };

      if (stream) {
        return new Response(agentLoop.createStream(req), {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      }

      const result = await agentLoop.run(req);

      return new Response(JSON.stringify(result), {
        headers: {
          "Content-Type": "application/json",
          "X-Request-Id": result.requestId,
          "X-Session-Id": result.sessionId,
        },
      });
    },
    {
      body: t.Object({
        task: t.String({
          description: "The task/goal for the autonomous agent",
        }),
        model: t.Optional(
          t.String({ description: "Virtual model (default: teamlead)" }),
        ),
        max_steps: t.Optional(
          t.Number({ description: "Max iterations (capped at 20)" }),
        ),
        stream: t.Optional(t.Boolean({ description: "Stream SSE events" })),
      }),
    },
  );
}
