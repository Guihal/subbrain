/**
 * Specialist fan-out: parallel calls via Promise.allSettled (NEVER Promise.all).
 * Per-participant AbortController for timeout cancel; external signal
 * propagated to all in-flight calls.
 */

import type { ParticipantOutput, RoomParticipant } from "./participants";
import type { AgentResponse } from "./types";
import type { TaskCategory } from "./weights";

export async function dispatchSpecialists(
  participants: RoomParticipant[],
  userMessage: string,
  executiveSummary: string,
  category: TaskCategory,
  timeout: number,
  externalSignal?: AbortSignal,
): Promise<AgentResponse[]> {
  const controllers = participants.map(() => new AbortController());
  const externalAbortHandler = () => {
    for (const c of controllers) c.abort();
  };
  if (externalSignal) {
    if (externalSignal.aborted) externalAbortHandler();
    else externalSignal.addEventListener("abort", externalAbortHandler, { once: true });
  }
  const settled = await Promise.allSettled(
    participants.map((p, i) =>
      p.ask({
        userMessage,
        executiveSummary,
        category,
        timeoutMs: timeout,
        signal: controllers[i].signal,
      }),
    ),
  );
  externalSignal?.removeEventListener("abort", externalAbortHandler);
  return settled.map((s, i) =>
    s.status === "fulfilled"
      ? mapOutput(s.value, participants[i].id)
      : {
          role: participants[i].id,
          content: "",
          latencyMs: 0,
          timedOut: false,
        },
  );
}

function mapOutput(out: ParticipantOutput, role: string): AgentResponse {
  return {
    role,
    content: out.content,
    latencyMs: out.latencyMs,
    timedOut: out.timedOut,
  };
}
