/**
 * Specialist fan-out: parallel calls via Promise.allSettled (NEVER Promise.all).
 * Per-specialist AbortController for timeout cancel; external signal
 * propagated to all in-flight calls.
 */

import type { Metrics } from "@subbrain/core/lib/metrics";
import type { ModelRouter } from "../../lib/model-router";
import { buildSpecialistSystemPrompt } from "./prompts";
import type { AgentResponse, RoomConfig } from "./types";
import type { TaskCategory } from "./weights";

interface DispatchDeps {
  router: ModelRouter;
  metrics: Metrics | null;
}

export async function dispatchSpecialists(
  deps: DispatchDeps,
  userMessage: string,
  executiveSummary: string,
  config: RoomConfig,
  timeout: number,
  externalSignal?: AbortSignal,
): Promise<AgentResponse[]> {
  // Per-specialist AbortControllers cancel stragglers on timeout — the timer
  // in `callSpecialist` aborts before rejecting so router.chat→fetch bails
  // (CANCEL-1 / PR 20). `callSpecialist` wraps errors; `allSettled` guards
  // against any future change where a single rejection shouldn't kill the room.
  const controllers = config.agents.map(() => new AbortController());
  // External abort (tool-runner timeout, parent cancel) propagates to all calls.
  const externalAbortHandler = () => {
    for (const c of controllers) c.abort();
  };
  if (externalSignal) {
    if (externalSignal.aborted) externalAbortHandler();
    else
      externalSignal.addEventListener("abort", externalAbortHandler, {
        once: true,
      });
  }
  const settled = await Promise.allSettled(
    config.agents.map((role, i) =>
      callSpecialist(
        deps,
        role,
        userMessage,
        executiveSummary,
        timeout,
        config.category,
        controllers[i],
      ),
    ),
  );
  externalSignal?.removeEventListener("abort", externalAbortHandler);
  return settled.map((s, i) =>
    s.status === "fulfilled"
      ? s.value
      : {
          role: config.agents[i],
          content: "",
          latencyMs: 0,
          timedOut: false,
        },
  );
}

async function callSpecialist(
  deps: DispatchDeps,
  role: string,
  userMessage: string,
  executiveSummary: string,
  timeout: number,
  category: TaskCategory,
  controller?: AbortController,
): Promise<AgentResponse> {
  const systemPrompt = buildSpecialistSystemPrompt(role, category, executiveSummary);

  const start = Date.now();

  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const response = await Promise.race([
      deps.router.chat(
        role,
        {
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userMessage },
          ],
          max_tokens: 2048,
          temperature: 0.7,
          signal: controller?.signal,
        },
        "critical",
      ),
      timeout > 0
        ? new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              // Abort BEFORE rejecting — else router.chat→fetch keeps running
              // after we've given up on the result.
              controller?.abort();
              reject(new Error("timeout"));
            }, timeout);
          })
        : new Promise<never>(() => {}),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });

    const content = response.choices[0]?.message?.content || "";
    const latencyMs = Date.now() - start;

    deps.metrics?.record({
      model: role,
      priority: "critical",
      stage: "main",
      latencyMs,
      tokensIn: response.usage?.prompt_tokens || 0,
      tokensOut: response.usage?.completion_tokens || 0,
      status: "ok",
    });

    return { role, content, latencyMs, timedOut: false };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const timedOut = (err as Error).message === "timeout";

    deps.metrics?.record({
      model: role,
      priority: "critical",
      stage: "main",
      latencyMs,
      tokensIn: 0,
      tokensOut: 0,
      status: "error",
      errorType: timedOut ? "timeout" : "other",
    });

    return { role, content: "", latencyMs, timedOut };
  }
}
