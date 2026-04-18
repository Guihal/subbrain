import { Elysia, t } from "elysia";
import type { AgentLoop } from "../pipeline/agent-loop";

export function autonomousRoute(agentLoop: AgentLoop) {
  return new Elysia().post(
    "/v1/autonomous",
    async ({ body, headers }) => {
      const stream = body.stream ?? false;
      const sessionId =
        (headers["x-session-id"] as string | undefined) || undefined;

      const req = {
        task: body.task,
        model: body.model,
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
