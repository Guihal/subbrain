<script setup lang="ts">
const {
  messages,
  currentChatId,
  streaming,
  loadChats,
  loadModels,
  sendMessage,
  checkHealth,
} = useChat();

const messagesContainer = ref<HTMLElement>();
const sidebarOpen = ref(false);

// Auto-scroll on new messages
watch(
  () =>
    messages.value.length && messages.value[messages.value.length - 1]?.content,
  () => {
    nextTick(() => {
      if (messagesContainer.value) {
        messagesContainer.value.scrollTop =
          messagesContainer.value.scrollHeight;
      }
    });
  },
);

// Deep watch for streaming updates (content changes within last message)
watch(
  messages,
  () => {
    if (streaming.value) {
      nextTick(() => {
        if (messagesContainer.value) {
          messagesContainer.value.scrollTop =
            messagesContainer.value.scrollHeight;
        }
      });
    }
  },
  { deep: true },
);

// Load data on mount
onMounted(async () => {
  await Promise.all([loadChats(), loadModels()]);
  checkHealth();
  // Health poll
  setInterval(checkHealth, 15000);
});

// Ctrl+L = new chat
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
  <div class="flex h-dvh">
    <!-- Mobile sidebar overlay -->
    <div
      v-if="sidebarOpen"
      class="fixed inset-0 z-40 bg-black/40 md:hidden"
      @click="sidebarOpen = false"
    />

    <!-- Sidebar -->
    <div
      class="w-64 min-w-64 border-r border-(--ui-border) bg-(--ui-bg-elevated) transition-transform duration-200"
      :class="[
        sidebarOpen ? 'fixed inset-y-0 left-0 z-50' : 'hidden',
        'md:relative md:block md:translate-x-0',
      ]"
    >
      <ChatSidebar @select="sidebarOpen = false" />
    </div>

    <!-- Main -->
    <div class="flex-1 flex flex-col min-w-0">
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

      <!-- Messages -->
      <div
        ref="messagesContainer"
        class="flex-1 overflow-y-auto px-4 md:px-6 py-4 space-y-3"
      >
        <!-- Empty state -->
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

        <!-- Chat empty -->
        <div
          v-else-if="messages.length === 0 && !streaming"
          class="flex-1 flex items-center justify-center h-full"
        >
          <p class="text-sm text-(--ui-text-dimmed)">Начни разговор…</p>
        </div>

        <!-- Messages -->
        <ChatMessage
          v-for="(msg, idx) in messages"
          :key="idx"
          :message="msg"
          :is-streaming="
            streaming && idx === messages.length - 1 && msg.role === 'assistant'
          "
        />
      </div>

      <ChatInput :disabled="streaming" @send="handleSend" />
    </div>
  </div>
</template>
