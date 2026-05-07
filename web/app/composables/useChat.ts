export type { ModelId, ModelItem } from "./useChatMode";
export type { Chat, ChatMessage, HealthData } from "./useChatState";

import type { HealthData } from "./useChatState";

export function useChat() {
  const state = useChatState();
  const mode = useChatMode();
  const persistence = useChatPersistence();
  const { sendMessage } = useChatSend();
  const health = useState<HealthData | null>("health", () => null);

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
    chats: state.chats,
    currentChatId: state.currentChatId,
    currentChat: state.currentChat,
    messages: state.messages,
    streaming: state.streaming,
    currentModel: mode.currentModel,
    directMode: mode.directMode,
    agentMode: mode.agentMode,
    health,
    models: mode.models,
    loadChats: persistence.loadChats,
    loadModels: mode.loadModels,
    openChat: persistence.openChat,
    createNewChat: persistence.createNewChat,
    deleteChat: persistence.deleteChat,
    renameChat: persistence.renameChat,
    sendMessage,
    cancelStream: state.cancelStream,
    checkHealth,
  };
}
