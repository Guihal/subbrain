/**
 * Arbitration Room branch — N specialists in parallel, team-lead synthesizes.
 * Returned as a synthetic ChatResponse so the rest of the pipeline is uniform.
 */

import type { RequestLogger } from "../../../lib/logger";
import type { Metrics } from "../../../lib/metrics";
import type { ChatResponse } from "../../../providers/types";
import type { ArbitrationRoom } from "../../arbitration";

export interface RoomResult {
  response: ChatResponse;
  synthesis: string;
}

export async function runRoom(args: {
  room: ArbitrationRoom;
  userMessage: string;
  systemPrompt: string;
  roomConfig: ReturnType<ArbitrationRoom["classify"]> & object;
  requestId: string;
  metrics: Metrics | null;
  log: RequestLogger;
}): Promise<RoomResult> {
  const { room, userMessage, systemPrompt, roomConfig, requestId, metrics, log } = args;

  log.info("main", `Arbitration Room activated: ${roomConfig.agents.join(",")}`, { model: "room" });
  const start = Date.now();
  const result = await room.run(userMessage, systemPrompt, roomConfig);
  const durationMs = Date.now() - start;

  log.info("main", `Room synthesis complete: ${result.synthesis.length} chars`, {
    model: "teamlead",
    durationMs,
  });
  metrics?.record({
    model: "room",
    priority: "critical",
    stage: "main",
    latencyMs: durationMs,
    tokensIn: 0,
    tokensOut: 0,
    status: "ok",
  });

  const response: ChatResponse = {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "teamlead",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: result.synthesis },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };

  return { response, synthesis: result.synthesis };
}
