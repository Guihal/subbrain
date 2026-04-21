import type { Chat, ChatMessage } from "./useChatState";
import type { ModelId } from "./useChatMode";

export function useChatPersistence() {
  const { api } = useApi();
  const { chats, currentChatId, messages, streaming } = useChatState();
  const { currentModel } = useChatMode();

  async function loadChats() {
    chats.value = await api<Chat[]>("/v1/chats/?limit=50");
  }

  async function openChat(chatId: string) {
    if (streaming.value) return;
    currentChatId.value = chatId;
    const msgs = await api<ChatMessage[]>(`/v1/chats/${chatId}/messages`);
    messages.value = msgs.filter(
      (m) => m.role === "user" || m.role === "assistant",
    );

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

  return { loadChats, openChat, createNewChat, deleteChat, renameChat };
}
