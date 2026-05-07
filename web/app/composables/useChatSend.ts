export function useChatSend() {
  const { rawFetch } = useApi();
  const state = useChatState();
  const mode = useChatMode();
  const persistence = useChatPersistence();
  const stream = useChatStream();

  function isAbortError(err: unknown): boolean {
    if (err instanceof DOMException && err.name === "AbortError") return true;
    if (typeof err === "object" && err !== null && "name" in err) {
      return (err as { name?: string }).name === "AbortError";
    }
    return false;
  }

  async function sendMessage(text: string): Promise<void> {
    if (!text.trim() || state.streaming.value) return;

    if (!state.currentChatId.value) {
      state.currentChatId.value = crypto.randomUUID();
    }

    state.messages.value = [...state.messages.value, { role: "user", content: text }];

    const history = state.messages.value.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    state.streaming.value = true;
    state.messages.value = [
      ...state.messages.value,
      { role: "assistant", content: "", reasoning: "" },
    ];

    const headers = mode.buildHeaders(state.currentChatId.value);
    const controller = new AbortController();
    state.streamAbort.value = controller;
    const signal = controller.signal;

    try {
      if (mode.agentMode.value) {
        const res = await rawFetch("/v1/autonomous", {
          method: "POST",
          headers,
          signal,
          body: JSON.stringify({
            task: text,
            model: mode.currentModel.value,
            max_steps: 12,
            stream: true,
          }),
        });

        if (!res.ok) {
          const err = await res.text();
          state.updateLastAssistant({
            content: `⚠️ Ошибка ${res.status}: ${err}`,
          });
          return;
        }

        await stream.readAgentSSE(res, signal);
        persistence.loadChats();
        return;
      }

      const res = await rawFetch("/v1/chat/completions", {
        method: "POST",
        headers,
        signal,
        body: JSON.stringify({
          model: mode.currentModel.value,
          messages: history,
          stream: true,
          max_tokens: 4096,
          temperature: 0.7,
        }),
      });

      if (!res.ok) {
        const err = await res.text();
        state.updateLastAssistant({
          content: `⚠️ Ошибка ${res.status}: ${err}`,
        });
        return;
      }

      await stream.readSSEStream(res, signal);
      persistence.loadChats();
    } catch (err: unknown) {
      if (isAbortError(err) || signal.aborted) {
        state.updateLastAssistant({ content: "⏹ Остановлено пользователем" });
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        state.updateLastAssistant({ content: `⚠️ Сетевая ошибка: ${msg}` });
      }
    } finally {
      state.streaming.value = false;
      if (state.streamAbort.value === controller) {
        state.streamAbort.value = null;
      }
    }
  }

  return { sendMessage };
}
