<script setup lang="ts">
import type { MemoryTab } from "~/composables/useMemory";

defineProps<{ active: MemoryTab }>();
const emit = defineEmits<{ switch: [tab: MemoryTab] }>();

const TABS: { id: MemoryTab; label: string }[] = [
  { id: "focus", label: "🎯 Focus" },
  { id: "shared", label: "👤 Shared" },
  { id: "context", label: "📝 Context" },
  { id: "archive", label: "📚 Archive" },
  { id: "agent", label: "🤖 Agent" },
  { id: "log", label: "📜 Log" },
];
</script>

<template>
  <div class="flex border-b border-(--ui-border) text-sm">
    <button
      v-for="tab in TABS"
      :key="tab.id"
      class="flex-1 py-2 transition-colors"
      :class="
        active === tab.id
          ? 'text-(--ui-text) border-b-2 border-(--ui-primary)'
          : 'text-(--ui-text-muted) hover:text-(--ui-text)'
      "
      @click="emit('switch', tab.id)"
    >
      {{ tab.label }}
    </button>
  </div>
</template>
