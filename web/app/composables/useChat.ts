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

/** Available virtual models */
export const MODELS = [
  { value: "flash", label: "Флэш", description: "Step 3.5 Flash" },
  { value: "coder", label: "Кодер", description: "Qwen3 Coder 480B" },
  { value: "teamlead", label: "Лид", description: "Kimi K2 Thinking" },
  { value: "critic", label: "Критик", description: "Devstral 123B" },
  { value: "generalist", label: "Генералист", description: "Mistral Large 3 675B" },
] as const;

export type ModelId = (typeof MODELS)[number]["value"];

export function useChat() {
  const { api, rawFetch } = useApi();

  const chats = useState<Chat[]>("chats", () => []);
  const currentChatId = useState<string | null>("current-chat", () => null);
  const messages = useState<ChatMessage[]>("messages", () => []);
  const streaming = useState("streaming", () => false);
  const currentModel = useState<ModelId>("model", () => "teamlead");
  const directMode = useState("direct-mode", () => false);
  const health = useState<HealthData | null>("health", () => null);

  const currentChat = computed(() =>
    chats.value.find((c) => c.id === currentChatId.value),
  );

  // ─── Chat management ─────────────────────────────────

  async function loadChats() {
    chats.value = await api<Chat[]>("/v1/chats/?source=web&limit=50");
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
              content += delta.content;
              updateLastAssistant({ content, reasoning });
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

  function updateLastAssistant(update: Partial<ChatMessage>) {
    const msgs = [...messages.value];
    const last = msgs[msgs.length - 1];
    if (last?.role === "assistant") {
      msgs[msgs.length - 1] = { ...last, ...update };
      messages.value = msgs;
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
    health,
    loadChats,
    openChat,
    createNewChat,
    deleteChat,
    renameChat,
    sendMessage,
    checkHealth,
  };
}
