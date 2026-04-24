import { Elysia, t } from "elysia";
import type { AgentService } from "../services/agent.service";
import type { MemoryDB } from "../db";
import { sseResponse } from "../lib/sse";

/**
 * `/v1/autonomous` — human-triggered interactive agent run (LAYER-4, PR 26b).
 * SCHED-1: explicit `interactive` so a future default change doesn't silently
 * strip code-tool authoring from this route. Scheduler-initiated runs use
 * `installAutonomousScheduler` / `installFreeAgentScheduler` and pass
 * `agentMode: "scheduled"`.
 */
export function autonomousRoute(agentService: AgentService, memory?: MemoryDB) {
  return new Elysia().post(
    "/v1/autonomous",
    async ({ body, headers }) => {
      const stream = body.stream ?? false;
      const sessionId = (headers["x-session-id"] as string | undefined) || undefined;
      const chatId = (headers["x-chat-id"] as string | undefined) || sessionId;
      const source = (headers["x-chat-source"] as string) || (sessionId ? "web" : "autonomous");
      const model = body.model || "teamlead";

      if (memory && chatId) {
        const existing = memory.getChat(chatId);
        if (!existing) memory.createChat(chatId, body.task.slice(0, 80), model, source);
        else if (existing.model !== model) memory.updateChatModel(chatId, model);
        memory.appendChatMessage(chatId, "user", body.task);
      }

      const opts = {
        task: body.task,
        model,
        maxSteps: body.max_steps,
        sessionId,
        agentMode: "interactive" as const,
      };

      if (stream) return sseResponse(agentService.createStream(opts));

      const result = await agentService.run(opts);
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
        task: t.String({ description: "The task/goal for the autonomous agent" }),
        model: t.Optional(t.String({ description: "Virtual model (default: teamlead)" })),
        max_steps: t.Optional(t.Number({ description: "Max iterations (capped at 20)" })),
        stream: t.Optional(t.Boolean({ description: "Stream SSE events" })),
      }),
    },
  );
}
