import { readAgentSSE } from "./readAgentSSE";
import { readSSEStream } from "./readChatSSE";

export type ChatStreamDeps = {
  updateLastAssistant: (patch: { content?: string; reasoning?: string }) => void;
  flushStreamingPaint: () => Promise<void>;
};

export function useChatStream() {
  const { updateLastAssistant, flushStreamingPaint } = useChatState();
  const deps: ChatStreamDeps = { updateLastAssistant, flushStreamingPaint };

  return {
    readSSEStream: (res: Response, signal?: AbortSignal) => readSSEStream(res, deps, signal),
    readAgentSSE: (res: Response, signal?: AbortSignal) => readAgentSSE(res, deps, signal),
  };
}
