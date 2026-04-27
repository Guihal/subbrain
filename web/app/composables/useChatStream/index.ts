import { readSSEStream } from "./readChatSSE";
import { readAgentSSE } from "./readAgentSSE";

export type ChatStreamDeps = {
  updateLastAssistant: (patch: { content?: string; reasoning?: string }) => void;
  flushStreamingPaint: () => Promise<void>;
};

export function useChatStream() {
  const { updateLastAssistant, flushStreamingPaint } = useChatState();
  const deps: ChatStreamDeps = { updateLastAssistant, flushStreamingPaint };

  return {
    readSSEStream: (res: Response) => readSSEStream(res, deps),
    readAgentSSE: (res: Response) => readAgentSSE(res, deps),
  };
}
