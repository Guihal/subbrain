<script setup lang="ts">
import type { MemoryRow } from "~/composables/useMemory";

defineProps<{
  selected: MemoryRow;
  badgeColor: string;
  rowBadge: string;
  formatTs: (ts: number) => string;
}>();
defineEmits<{ close: [] }>();
</script>

<template>
  <div class="flex items-center gap-2">
    <span :class="badgeColor" class="text-xs font-mono">
      {{ rowBadge }}
    </span>
    <span
      v-if="selected.__kind !== 'focus' && selected.__kind !== 'log'"
      class="text-xs text-(--ui-text-dimmed) ml-auto"
    >
      {{ formatTs((selected as { updated_at: number }).updated_at) }}
    </span>
    <button
      class="text-(--ui-text-muted) hover:text-(--ui-text)"
      title="Закрыть"
      @click="$emit('close')"
    >
      <UIcon name="i-lucide-x" class="size-4" />
    </button>
  </div>
</template>
