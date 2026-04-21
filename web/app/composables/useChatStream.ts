export function useChatStream() {
  const { updateLastAssistant, flushStreamingPaint } = useChatState();

  /**
   * Incremental <think>...</think> splitter. Routes chars entering while
   * inside a think block to `reasoning`, rest to `content`. Handles partial
   * tags arriving across SSE chunks via a small carry buffer.
   */
  function makeThinkSplitter() {
    let inThink = false;
    let carry = ""; // partial tag awaiting completion
    return (delta: string, onContent: (s: string) => void, onThink: (s: string) => void) => {
      let buf = carry + delta;
      carry = "";
      while (buf.length > 0) {
        if (inThink) {
          const close = buf.indexOf("</think>");
          if (close === -1) {
            // Keep a tail that could be a partial "</think>" prefix.
            const tail = Math.min(buf.length, 7);
            onThink(buf.slice(0, buf.length - tail));
            carry = buf.slice(buf.length - tail);
            // Only carry if the tail is actually a prefix of "</think>".
            if (!"</think>".startsWith(carry)) {
              onThink(carry);
              carry = "";
            }
            return;
          }
          onThink(buf.slice(0, close));
          buf = buf.slice(close + "</think>".length);
          inThink = false;
        } else {
          const open = buf.indexOf("<think>");
          if (open === -1) {
            const tail = Math.min(buf.length, 6);
            onContent(buf.slice(0, buf.length - tail));
            carry = buf.slice(buf.length - tail);
            if (!"<think>".startsWith(carry)) {
              onContent(carry);
              carry = "";
            }
            return;
          }
          onContent(buf.slice(0, open));
          buf = buf.slice(open + "<think>".length);
          inThink = true;
        }
      }
    };
  }

  async function readSSEStream(res: Response) {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let reasoning = "";
    const split = makeThinkSplitter();

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
              split(
                delta.content,
                (c) => { content += c; },
                (r) => { reasoning += r; },
              );
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
