<script setup lang="ts">
const {
  messages,
  currentChatId,
  streaming,
  loadChats,
  loadModels,
  sendMessage,
  cancelStream,
  checkHealth,
} = useChat();

const sidebarOpen = useState("sidebar-open", () => false);
const messagesContainer = ref<HTMLElement>();

// Auto-scroll on new messages
watch(
  () => messages.value.length && messages.value[messages.value.length - 1]?.content,
  () => {
    nextTick(() => {
      if (messagesContainer.value) {
        messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight;
      }
    });
  },
);

// Deep watch for streaming updates
watch(
  messages,
  () => {
    if (streaming.value) {
      nextTick(() => {
        if (messagesContainer.value) {
          messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight;
        }
      });
    }
  },
  { deep: true },
);

let healthTimer: ReturnType<typeof setInterval> | null = null;

onMounted(async () => {
  await Promise.all([loadChats(), loadModels()]);
  checkHealth();
  healthTimer = setInterval(checkHealth, 15000);
});

onUnmounted(() => {
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = null;
});

useEventListener("keydown", (e: KeyboardEvent) => {
  if (e.ctrlKey && e.key === "l") {
    e.preventDefault();
    useChat().createNewChat();
  }
});

async function handleSend(text: string) {
  await sendMessage(text);
}
</script>

<template>
  <ChatHeader>
    <template #leading>
      <UButton
        icon="i-lucide-menu"
        variant="ghost"
        size="sm"
        class="md:hidden"
        @click="sidebarOpen = !sidebarOpen"
      />
    </template>
  </ChatHeader>

  <div
    ref="messagesContainer"
    class="flex-1 overflow-y-auto px-4 md:px-6 py-4 space-y-3"
  >
    <div
      v-if="!currentChatId"
      class="flex-1 flex items-center justify-center h-full"
    >
      <div class="text-center text-(--ui-text-muted)">
        <div class="text-4xl mb-3">🧠</div>
        <p class="text-sm">Выбери чат или создай новый</p>
        <p class="text-xs mt-1 text-(--ui-text-dimmed)">
          Ctrl+L — новый чат
        </p>
      </div>
    </div>

    <div
      v-else-if="messages.length === 0 && !streaming"
      class="flex-1 flex items-center justify-center h-full"
    >
      <p class="text-sm text-(--ui-text-dimmed)">Начни разговор…</p>
    </div>

    <ChatMessage
      v-for="(msg, idx) in messages"
      :key="idx"
      :message="msg"
      :is-streaming="
        streaming && idx === messages.length - 1 && msg.role === 'assistant'
      "
    />
  </div>

  <ChatInput
    :disabled="streaming"
    :streaming="streaming"
    @send="handleSend"
    @cancel="cancelStream"
  />
</template>
