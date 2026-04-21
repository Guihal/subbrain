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

export function useChatState() {
  const chats = useState<Chat[]>("chats", () => []);
  const currentChatId = useState<string | null>("current-chat", () => null);
  const messages = useState<ChatMessage[]>("messages", () => []);
  const streaming = useState("streaming", () => false);

  const currentChat = computed(() =>
    chats.value.find((c) => c.id === currentChatId.value),
  );

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

  return {
    chats,
    currentChatId,
    currentChat,
    messages,
    streaming,
    updateLastAssistant,
    flushStreamingPaint,
  };
}
