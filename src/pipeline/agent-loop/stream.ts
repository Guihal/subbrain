/**
 * runStreamLoop — SSE streaming agent loop. Shares `executeStep` with
 * `runLoop`; emits events via hooks and wraps the whole thing in
 * `setupHeartbeat` so Caddy does not RST long-idle streams.
 */
import { randomUUID } from "crypto";
import type { Message } from "../../providers/types";
import { logger } from "../../lib/logger";
import {
  MAX_STEPS,
  AGENT_MODEL,
  type AgentLoopRequest,
} from "./types";
import { buildAgentSystemPrompt } from "./system-prompt";
import { executeStep } from "./step";
import { setupHeartbeat } from "./heartbeat";
import { persistToChat } from "./persist";
import { firePost, stepDeps, type AgentLoopDeps } from "./shared";
import type { AgentLoopSession } from "../../mcp/registry/tool-registry";

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
        safeEnqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
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
        const requestId = randomUUID();
        const sessionId = req.sessionId || randomUUID();
        const model = req.model || AGENT_MODEL;
        const maxSteps = Math.min(req.maxSteps || MAX_STEPS, MAX_STEPS);
        const priority = req.priority || "critical";
        const log = logger.forRequest(requestId, sessionId);

        const session: AgentLoopSession = {
          consultSpecialistsCount: 0,
          consultSpecialistsMax: Math.max(
            1,
            Number(process.env.AGENT_CONSULT_SPECIALISTS_MAX) || 3,
          ),
          consultChaosCount: 0,
          consultChaosMax: Math.max(
            1,
            Number(process.env.AGENT_CONSULT_CHAOS_MAX) || 5,
          ),
        };

        let lastContent = "";
        let finishedViaDone = false;

        emit("start", { requestId, sessionId, model, maxSteps });
        emit("pre_processing", { status: "building_system_prompt" });

        const systemPrompt = await buildAgentSystemPrompt(
          deps.memory,
          deps.rag,
          req.task,
          model,
          deps.router,
          req.schedule,
        );
        const messages: Message[] = [
          { role: "system", content: systemPrompt },
          { role: "user", content: req.task },
        ];

        for (let step = 1; step <= maxSteps; step++) {
          emit("step", { step, maxSteps, status: "thinking" });

          const result = await executeStep(
            stepDeps(deps, session),
            {
              step,
              maxSteps,
              model,
              priority,
              messages,
              getAllTools: deps.getAllTools,
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
              onWarn: () =>
                emit("warn", { step, error: "Empty response, nudging" }),
            },
          );

          if (result.kind === "done") {
            emit("done", { step, summary: result.summary });
            deps.memory.appendLog(requestId, sessionId, model, "user", req.task);
            deps.memory.appendLog(
              requestId,
              sessionId,
              model,
              "assistant",
              `[Autonomous: ${step} steps] ${result.summary}`,
            );
            persistToChat(
              deps.memory,
              sessionId,
              requestId,
              model,
              req.task,
              result.summary,
            );
            firePost(
              deps,
              {
                requestId,
                sessionId,
                model,
                userMessage: req.task,
                assistantMessage: result.summary,
              },
              log,
            );
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
          const summary =
            lastContent || "Agent reached max steps without calling done";
          const requestIdRef = requestId;
          const sessionIdRef = sessionId;
          deps.memory.appendLog(requestIdRef, sessionIdRef, model, "user", req.task);
          deps.memory.appendLog(
            requestIdRef,
            sessionIdRef,
            model,
            "assistant",
            `[Autonomous: max_steps] ${summary}`,
          );
          persistToChat(
            deps.memory,
            sessionIdRef,
            requestIdRef,
            model,
            req.task,
            summary,
          );
          firePost(
            deps,
            {
              requestId: requestIdRef,
              sessionId: sessionIdRef,
              model,
              userMessage: req.task,
              assistantMessage: summary,
            },
            log,
          );
        }

        finish();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        safeEnqueue(
          encoder.encode(
            `event: error\ndata: ${JSON.stringify({ error: msg })}\n\n`,
          ),
        );
        finish();
      }
    },
  });
}
