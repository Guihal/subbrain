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
  const streamAbort = useState<AbortController | null>("stream-abort", () => null);

  const currentChat = computed(() => chats.value.find((c) => c.id === currentChatId.value));

  function cancelStream() {
    const ctrl = streamAbort.value;
    if (ctrl && !ctrl.signal.aborted) ctrl.abort();
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
    // Double-rAF: first rAF callback runs BEFORE paint; we need to yield
    // until AFTER paint so the next stream chunk doesn't pre-empt rendering.
    // Without this, Chrome desktop coalesces all chunk-driven re-renders
    // into a single paint at stream end (mobile Chrome paints sooner due
    // to slower network gaps between chunks).
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  }

  return {
    chats,
    currentChatId,
    currentChat,
    messages,
    streaming,
    streamAbort,
    cancelStream,
    updateLastAssistant,
    flushStreamingPaint,
  };
}
