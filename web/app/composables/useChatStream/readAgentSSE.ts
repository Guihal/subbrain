import type { ChatStreamDeps } from "./index";

export async function readAgentSSE(res: Response, deps: ChatStreamDeps) {
  const { updateLastAssistant, flushStreamingPaint } = deps;
  if (!res.body) {
    updateLastAssistant({ content: "⚠️ Пустой ответ (no body)" });
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let reasoning = "";
  let content = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() || "";

      let didUpdate = false;

      for (const frame of frames) {
        const lines = frame.split(/\r?\n/);
        let currentEvent = "";
        let payload = "";

        for (const line of lines) {
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7).trim();
            continue;
          }
          if (line.startsWith("data: ")) {
            payload += line.slice(6).trim();
          }
        }

        if (!payload) continue;

        try {
          const data = JSON.parse(payload);

          switch (currentEvent) {
            case "step":
              reasoning += `\n── Шаг ${data.step}/${data.maxSteps}: ${data.status}\n`;
              didUpdate = true;
              break;
            case "tool_call":
              reasoning += `🛠 ${data.name}(${(data.args || "").slice(0, 120)})\n`;
              didUpdate = true;
              break;
            case "tool_result":
              reasoning += `→ ${(data.result || "").slice(0, 200)}\n`;
              didUpdate = true;
              break;
            case "response":
              content = data.content || "";
              didUpdate = true;
              break;
            case "done":
              content = data.summary || "";
              didUpdate = true;
              break;
            case "error":
              content += `\n⚠️ ${data.error}`;
              didUpdate = true;
              break;
            case "thinking":
              reasoning += `\n💭 ${data.content || ""}\n`;
              didUpdate = true;
              break;
          }
        } catch {
          // Malformed JSON
        }
      }

      if (didUpdate) {
        updateLastAssistant({ content, reasoning });
        await flushStreamingPaint();
      }
    }
  } finally {
    reader.releaseLock();
  }
}
