import { parseSSEChunk } from "../../providers/sse-parser";
import type { ChatRepository } from "../../repositories";

/**
 * Wraps an upstream SSE stream so the assembled assistant message + reasoning
 * are persisted to `chats` once the stream completes. Honors `cancel()` —
 * sets `isClosed`, skips the DB write, and propagates cancellation upstream.
 */
export function wrapStreamForChat(
  stream: ReadableStream<Uint8Array>,
  chatRepo: ChatRepository,
  chatId: string,
  model: string,
  requestId?: string,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let fullContent = "";
  let fullReasoning = "";
  let buffer = "";
  let isClosed = false;
  let innerReader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  return new ReadableStream({
    async start(controller) {
      innerReader = stream.getReader();
      try {
        while (true) {
          const { done, value } = await innerReader.read();
          if (done || isClosed) break;
          controller.enqueue(value);
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) {
            const delta = parseSSEChunk(line);
            if (!delta) continue;
            if (delta.content) fullContent += delta.content;
            if (delta.reasoning_content) fullReasoning += delta.reasoning_content;
          }
        }
      } catch (err) {
        if (!isClosed) controller.error(err);
        return;
      }
      if (isClosed) return; // client disconnected mid-stream
      if (fullContent) {
        chatRepo.appendChatMessage(chatId, "assistant", fullContent, {
          reasoning: fullReasoning || undefined,
          model,
          requestId,
        });
      }
      controller.close();
    },
    cancel(reason) {
      isClosed = true;
      innerReader?.cancel(reason).catch(() => {});
    },
  });
}
