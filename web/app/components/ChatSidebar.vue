<script setup lang="ts">
import type { Chat } from "~/composables/useChat";

const emit = defineEmits<{
  select: [];
}>();

const { chats, currentChatId, createNewChat, openChat, deleteChat, health } =
  useChat();

const confirmDelete = ref<string | null>(null);
const activeTab = ref<"all" | "my" | "autonomous">("all");
const showDeleteModal = computed({
  get: () => confirmDelete.value !== null,
  set: (v) => {
    if (!v) confirmDelete.value = null;
  },
});

function handleDelete(chatId: string) {
  confirmDelete.value = chatId;
}

function doDelete(chatId: string) {
  deleteChat(chatId);
  confirmDelete.value = null;
}

function handleOpen(chatId: string) {
  openChat(chatId);
  emit("select");
}

function handleNewChat() {
  createNewChat();
  emit("select");
}

function sourceColor(source: string) {
  const map: Record<string, string> = {
    web: "text-blue-400",
    api: "text-green-400",
    continue: "text-purple-400",
    autonomous: "text-orange-400",
    telegram: "text-sky-400",
  };
  return map[source] || "text-(--ui-text-muted)";
}

const filteredChats = computed(() => {
  if (activeTab.value === "autonomous") return chats.value.filter((c) => c.source === "autonomous");
  if (activeTab.value === "my") return chats.value.filter((c) => c.source !== "autonomous");
  return chats.value;
});
</script>

<template>
  <div class="flex flex-col h-full bg-(--ui-bg-elevated)">
    <!-- New chat button -->
    <div class="p-3 border-b border-(--ui-border)">
      <UButton
        icon="i-lucide-plus"
        label="Новый чат"
        block
        @click="handleNewChat"
      />
    </div>

    <!-- Tabs -->
    <div class="flex border-b border-(--ui-border) text-xs">
      <button
        class="flex-1 py-1.5 transition-colors"
        :class="activeTab === 'all' ? 'text-(--ui-text) border-b-2 border-(--ui-primary)' : 'text-(--ui-text-muted) hover:text-(--ui-text)'"
        @click="activeTab = 'all'"
      >
        Все
      </button>
      <button
        class="flex-1 py-1.5 transition-colors"
        :class="activeTab === 'my' ? 'text-(--ui-text) border-b-2 border-(--ui-primary)' : 'text-(--ui-text-muted) hover:text-(--ui-text)'"
        @click="activeTab = 'my'"
      >
        Мои
      </button>
      <button
        class="flex-1 py-1.5 transition-colors"
        :class="activeTab === 'autonomous' ? 'text-orange-400 border-b-2 border-orange-400' : 'text-(--ui-text-muted) hover:text-(--ui-text)'"
        @click="activeTab = 'autonomous'"
      >
        🤖 Авто
      </button>
    </div>

    <!-- Chat list -->
    <div class="flex-1 overflow-y-auto p-2 space-y-0.5">
      <div
        v-for="chat in filteredChats"
        :key="chat.id"
        class="group flex items-center gap-1.5 px-2.5 py-2 rounded-lg cursor-pointer text-sm transition-colors"
        :class="
          chat.id === currentChatId
            ? 'bg-(--ui-bg-accented) text-(--ui-text)'
            : 'text-(--ui-text-muted) hover:bg-(--ui-bg)/60 hover:text-(--ui-text)'
        "
        @click="handleOpen(chat.id)"
      >
        <span
          class="text-[10px] font-mono shrink-0"
          :class="sourceColor(chat.source)"
        >
          {{ chat.source }}
        </span>
        <span class="truncate flex-1">
          {{ chat.title || "Без названия" }}
        </span>
        <button
          class="opacity-0 group-hover:opacity-100 text-(--ui-text-muted) hover:text-red-400 transition-opacity shrink-0"
          title="Удалить"
          @click.stop="handleDelete(chat.id)"
        >
          <UIcon name="i-lucide-x" class="size-3.5" />
        </button>
      </div>
      <div
        v-if="filteredChats.length === 0"
        class="text-center text-(--ui-text-dimmed) text-sm py-8"
      >
        Нет чатов
      </div>
    </div>

    <!-- Status bar -->
    <div
      class="p-2.5 border-t border-(--ui-border) flex items-center gap-2 text-xs text-(--ui-text-muted)"
    >
      <span
        class="size-2 rounded-full shrink-0"
        :class="health ? 'bg-green-500' : 'bg-red-500'"
      />
      <span>{{ health ? "Подключён" : "Отключён" }}</span>
      <span v-if="health" class="ml-auto font-mono">
        {{ health.rpm.currentLoad }}/{{
          health.rpm.currentLoad + health.rpm.availableSlots
        }}
        RPM
      </span>
    </div>

    <!-- Delete confirmation -->
    <UModal v-model:open="showDeleteModal" title="Удалить чат?">
      <template #body>
        <p class="text-sm text-(--ui-text-muted)">Отменить нельзя.</p>
      </template>
      <template #footer>
        <div class="flex gap-2 justify-end">
          <UButton
            variant="ghost"
            label="Отмена"
            @click="confirmDelete = null"
          />
          <UButton
            color="red"
            label="Удалить"
            @click="doDelete(confirmDelete!)"
          />
        </div>
      </template>
    </UModal>
  </div>
</template>
