export function useChatStream() {
  const { updateLastAssistant, flushStreamingPaint } = useChatState();

  async function readSSEStream(res: Response) {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let reasoning = "";

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

            if (delta.reasoning_content) {
              reasoning += delta.reasoning_content;
              updateLastAssistant({ reasoning, content });
              didUpdate = true;
            }
            if (delta.content) {
              content += delta.content;
              const thinkRegex = /<think>([\s\S]*?)<\/think>/g;
              let thinkMatch;
              while ((thinkMatch = thinkRegex.exec(content)) !== null) {
                reasoning += thinkMatch[1];
              }
              const cleanContent = content
                .replace(/<think>[\s\S]*?<\/think>/g, "")
                .trim();
              updateLastAssistant({ content: cleanContent, reasoning });
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
      reader.releaseLock();
    }

    if (!content && reasoning) {
      updateLastAssistant({ content: reasoning, reasoning });
    }
  }

  async function readAgentSSE(res: Response) {
    const reader = res.body!.getReader();
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
                content = extractThinkFromContent(data.content || "", (t) => {
                  reasoning += t;
                });
                didUpdate = true;
                break;
              case "done":
                content = extractThinkFromContent(data.summary || "", (t) => {
                  reasoning += t;
                });
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

  function extractThinkFromContent(
    text: string,
    onThink: (t: string) => void,
  ): string {
    const thinkRegex = /<think>([\s\S]*?)<\/think>/g;
    let match;
    while ((match = thinkRegex.exec(text)) !== null) {
      onThink(match[1] || "");
    }
    return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  }

  return { readSSEStream, readAgentSSE };
}
