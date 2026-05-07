import type { ChatStreamDeps } from "./index";

export async function readSSEStream(res: Response, deps: ChatStreamDeps, signal?: AbortSignal) {
  const { updateLastAssistant, flushStreamingPaint } = deps;
  if (!res.body) {
    updateLastAssistant({ content: "⚠️ Пустой ответ (no body)" });
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let reasoning = "";

  const onAbort = () => {
    reader.cancel().catch(() => {
      // reader already released — ignore
    });
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      let didUpdate = false;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") continue;

        try {
          const chunk = JSON.parse(payload);
          const delta = chunk.choices?.[0]?.delta;
          if (!delta) continue;

          if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
            reasoning += delta.reasoning_content;
            updateLastAssistant({ reasoning, content });
            didUpdate = true;
          }
          if (typeof delta.content === "string" && delta.content) {
            content += delta.content;
            updateLastAssistant({ content: content.trim(), reasoning });
            didUpdate = true;
          }
        } catch {
          // Malformed chunk
        }
      }

      if (didUpdate) {
        await flushStreamingPaint();
      }
    }
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }

  if (!content && reasoning) {
    updateLastAssistant({ content: reasoning, reasoning });
  }
}
