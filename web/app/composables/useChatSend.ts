export function useChatSend() {
  const { rawFetch } = useApi();
  const state = useChatState();
  const mode = useChatMode();
  const persistence = useChatPersistence();
  const stream = useChatStream();

  async function sendMessage(text: string): Promise<void> {
    if (!text.trim() || state.streaming.value) return;

    if (!state.currentChatId.value) {
      state.currentChatId.value = crypto.randomUUID();
    }

    state.messages.value = [
      ...state.messages.value,
      { role: "user", content: text },
    ];

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

    try {
      if (mode.agentMode.value) {
        const res = await rawFetch("/v1/autonomous", {
          method: "POST",
          headers,
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
          state.streaming.value = false;
          return;
        }

        await stream.readAgentSSE(res);
        persistence.loadChats();
        return;
      }

      const res = await rawFetch("/v1/chat/completions", {
        method: "POST",
        headers,
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
        state.streaming.value = false;
        return;
      }

      await stream.readSSEStream(res);
      persistence.loadChats();
    } catch (err: any) {
      state.updateLastAssistant({
        content: `⚠️ Сетевая ошибка: ${err.message}`,
      });
    } finally {
      state.streaming.value = false;
    }
  }

  return { sendMessage };
}
