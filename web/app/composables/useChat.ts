export interface Chat {
  id: string;
  title: string;
  model: string;
  source: string;
  created_at: number;
  updated_at: number;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  model?: string;
  requestId?: string;
  created_at?: number;
}

export interface HealthData {
  status: string;
  rpm: {
    currentLoad: number;
    availableSlots: number;
    queueLength: number;
  };
}

/** Model item from API */
export interface ModelItem {
  value: string;
  label: string;
  description: string;
}

export type ModelId = string;

export function useChat() {
  const { api, rawFetch } = useApi();

  const chats = useState<Chat[]>("chats", () => []);
  const currentChatId = useState<string | null>("current-chat", () => null);
  const messages = useState<ChatMessage[]>("messages", () => []);
  const streaming = useState("streaming", () => false);
  const currentModel = useState<ModelId>("model", () => "teamlead");
  const directMode = useState("direct-mode", () => false);
  const agentMode = useState("agent-mode", () => true);
  const health = useState<HealthData | null>("health", () => null);
  const models = useState<ModelItem[]>("models", () => []);

  const currentChat = computed(() =>
    chats.value.find((c) => c.id === currentChatId.value),
  );

  // ─── Chat management ─────────────────────────────────

  async function loadChats() {
    chats.value = await api<Chat[]>("/v1/chats/?source=web&limit=50");
  }

  async function loadModels() {
    try {
      const res = await api<{ data: Array<{ id: string; label?: string; description?: string }> }>("/v1/models");
      models.value = res.data.map((m) => ({
        value: m.id,
        label: m.label || m.id,
        description: m.description || "",
      }));
    } catch {
      // Fallback: at least show teamlead
      if (models.value.length === 0) {
        models.value = [{ value: "teamlead", label: "Лид", description: "Default" }];
      }
    }
  }

  async function openChat(chatId: string) {
    if (streaming.value) return;
    currentChatId.value = chatId;
    const msgs = await api<ChatMessage[]>(`/v1/chats/${chatId}/messages`);
    messages.value = msgs.filter(
      (m) => m.role === "user" || m.role === "assistant",
    );

    // Sync model
    const chat = chats.value.find((c) => c.id === chatId);
    if (chat?.model) {
      currentModel.value = chat.model as ModelId;
    }
  }

  function createNewChat() {
    if (streaming.value) return;
    currentChatId.value = crypto.randomUUID();
    messages.value = [];
  }

  async function deleteChat(chatId: string) {
    await api(`/v1/chats/${chatId}`, { method: "DELETE" });
    if (currentChatId.value === chatId) {
      currentChatId.value = null;
      messages.value = [];
    }
    await loadChats();
  }

  async function renameChat(chatId: string, title: string) {
    await api(`/v1/chats/${chatId}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    });
    await loadChats();
  }

  // ─── Send message with SSE streaming ──────────────────

  async function sendMessage(text: string): Promise<void> {
    if (!text.trim() || streaming.value) return;

    if (!currentChatId.value) {
      currentChatId.value = crypto.randomUUID();
    }

    // Add user message
    messages.value = [...messages.value, { role: "user", content: text }];

    // Prepare history for API
    const history = messages.value.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    streaming.value = true;

    // Add empty assistant message
    const assistantMsg: ChatMessage = {
      role: "assistant",
      content: "",
      reasoning: "",
    };
    messages.value = [...messages.value, assistantMsg];

    const headers: Record<string, string> = {
      "X-Session-Id": currentChatId.value,
      "X-Chat-Id": currentChatId.value,
      "X-Chat-Source": "web",
      Accept: "text/event-stream",
    };
    if (directMode.value) headers["X-Direct-Mode"] = "true";

    try {
      // Agent mode: use autonomous endpoint with tool loop
      if (agentMode.value) {
        const res = await rawFetch("/v1/autonomous", {
          method: "POST",
          headers,
          body: JSON.stringify({
            task: text,
            model: currentModel.value,
            max_steps: 12,
            stream: true,
          }),
        });

        if (!res.ok) {
          const err = await res.text();
          updateLastAssistant({
            content: `\u26a0\ufe0f \u041e\u0448\u0438\u0431\u043a\u0430 ${res.status}: ${err}`,
          });
          streaming.value = false;
          return;
        }

        await readAgentSSE(res);
        loadChats();
        return;
      }

      // Normal chat mode
      const res = await rawFetch("/v1/chat/completions", {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: currentModel.value,
          messages: history,
          stream: true,
          max_tokens: 4096,
          temperature: 0.7,
        }),
      });

      if (!res.ok) {
        const err = await res.text();
        updateLastAssistant({ content: `⚠️ Ошибка ${res.status}: ${err}` });
        streaming.value = false;
        return;
      }

      await readSSEStream(res);
      loadChats(); // Refresh sidebar (auto-title)
    } catch (err: any) {
      updateLastAssistant({
        content: `⚠️ Сетевая ошибка: ${err.message}`,
      });
    } finally {
      streaming.value = false;
    }
  }

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
              // Handle <think> tags in streamed content
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

    // Fallback: if only reasoning, show as content
    if (!content && reasoning) {
      updateLastAssistant({ content: reasoning, reasoning });
    }
  }

  // ─── Agent SSE parser ─────────────────────────────────

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
        }

        if (didUpdate) await flushStreamingPaint();
      }
    } finally {
      reader.releaseLock();
    }
  }

  /** Extract <think>...</think> from content into reasoning callback */
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

  function updateLastAssistant(update: Partial<ChatMessage>) {
    const msgs = [...messages.value];
    const last = msgs[msgs.length - 1];
    if (last?.role === "assistant") {
      msgs[msgs.length - 1] = { ...last, ...update };
      messages.value = msgs;
      triggerRef(messages);
    }
  }

  async function flushStreamingPaint() {
    await nextTick();

    if (!import.meta.client) return;

    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  }

  // ─── Health ───────────────────────────────────────────

  async function checkHealth() {
    try {
      const config = useRuntimeConfig();
      const base = config.public.apiBase || "";
      health.value = await $fetch<HealthData>(`${base}/health`);
    } catch {
      health.value = null;
    }
  }

  return {
    chats,
    currentChatId,
    currentChat,
    messages,
    streaming,
    currentModel,
    directMode,
    agentMode,
    health,
    models,
    loadChats,
    loadModels,
    openChat,
    createNewChat,
    deleteChat,
    renameChat,
    sendMessage,
    checkHealth,
  };
}
