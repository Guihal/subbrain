/**
 * runStreamLoop — SSE streaming agent loop. Shares session init + finalization
 * with `runLoop` (see shared.ts); wraps the step iteration in SSE events and
 * a heartbeat so Caddy does not RST long-idle streams.
 */

import { setupHeartbeat } from "./heartbeat";
import { type AgentLoopDeps, finalizeAgentRun, initAgentLoopContext, stepDeps } from "./shared";
import { executeStep } from "./step";
import type { AgentLoopRequest } from "./types";

export function runStreamLoop(
  deps: AgentLoopDeps,
  req: AgentLoopRequest,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      let closed = false;
      const safeEnqueue = (chunk: Uint8Array) => {
        if (closed) return;
        try {
          controller.enqueue(chunk);
        } catch {
          closed = true;
        }
      };
      const emit = (event: string, data: unknown) => {
        safeEnqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      const heartbeat = setupHeartbeat(safeEnqueue, encoder);

      const finish = () => {
        safeEnqueue(encoder.encode("event: end\ndata: {}\n\n"));
        heartbeat.stop();
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      try {
        const ctx = await initAgentLoopContext(deps, req);
        const {
          requestId,
          sessionId,
          model,
          maxSteps,
          priority,
          agentMode,
          agentId,
          log,
          session,
          messages,
        } = ctx;

        let lastContent = "";
        let finishedViaDone = false;

        emit("start", { requestId, sessionId, model, maxSteps });
        emit("pre_processing", { status: "building_system_prompt" });

        for (let step = 1; step <= maxSteps; step++) {
          emit("step", { step, maxSteps, status: "thinking" });

          const result = await executeStep(
            stepDeps(deps, session, agentId, agentMode),
            {
              step,
              maxSteps,
              model,
              priority,
              messages,
              getAllTools: () => deps.getAllTools(agentMode),
            },
            log,
            {
              onCompress: (before, after) => {
                emit("compressing", { tokens: before });
                emit("compressed", { tokens: after });
              },
              onThinking: (content) => emit("thinking", { step, content }),
              onToolCallStart: (tc) =>
                emit("tool_call", {
                  step,
                  name: tc.function.name,
                  args: tc.function.arguments,
                }),
              onToolCallResult: (tc, toolResult) =>
                emit("tool_result", {
                  step,
                  name: tc.function.name,
                  result: toolResult.slice(0, 2000),
                }),
              onAssistantContent: (content) => {
                lastContent = content;
                emit("response", { step, content });
              },
              onWarn: () => emit("warn", { step, error: "Empty response, nudging" }),
            },
          );

          if (result.kind === "done") {
            emit("done", { step, summary: result.summary });
            finalizeAgentRun(deps, ctx, req, result.summary, `[Autonomous: ${step} steps]`);
            finishedViaDone = true;
            finish();
            return;
          }
          if (result.kind === "error") {
            emit("error", { step, error: result.error });
            break;
          }
        }

        if (!finishedViaDone) {
          const summary = lastContent || "Agent reached max steps without calling done";
          finalizeAgentRun(deps, ctx, req, summary, "[Autonomous: max_steps]");
        }

        finish();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        safeEnqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ error: msg })}\n\n`));
        finish();
      }
    },
  });
}
