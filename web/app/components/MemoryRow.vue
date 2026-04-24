<script setup lang="ts">
import type { MemoryRow as Row } from "~/composables/useMemory";

defineProps<{
  row: Row;
  title: string;
  badge: string;
  badgeColor: string;
  ts?: number;
  preview?: string;
  selected?: boolean;
  deletable?: boolean;
  pending?: boolean;
}>();

const emit = defineEmits<{
  select: [];
  delete: [];
  approve: [];
  reject: [];
}>();

function fmt(ts: number): string {
  return new Date(ts * 1000).toLocaleString("ru-RU", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}
</script>

<template>
  <div
    class="group flex items-start gap-2 px-3 py-2 cursor-pointer text-sm border-b border-(--ui-border)/30 transition-colors"
    :class="
      selected
        ? 'bg-(--ui-bg-accented) text-(--ui-text)'
        : 'text-(--ui-text-muted) hover:bg-(--ui-bg)/60 hover:text-(--ui-text)'
    "
    @click="emit('select')"
  >
    <span
      class="text-[10px] font-mono shrink-0 mt-0.5 min-w-14 truncate"
      :class="badgeColor"
      :title="badge"
    >
      {{ badge }}
    </span>
    <div class="flex-1 min-w-0">
      <div class="truncate">{{ title }}</div>
      <div
        v-if="preview"
        class="text-xs text-(--ui-text-dimmed) truncate mt-0.5"
      >
        {{ preview }}
      </div>
    </div>
    <span
      v-if="ts"
      class="text-[10px] text-(--ui-text-dimmed) shrink-0 mt-1"
    >
      {{ fmt(ts) }}
    </span>
    <template v-if="pending">
      <button
        class="shrink-0 px-1.5 py-0.5 text-[11px] rounded border border-green-500/40 text-green-400 hover:bg-green-500/10"
        title="Approve"
        @click.stop="emit('approve')"
      >
        ✓ Approve
      </button>
      <button
        class="shrink-0 px-1.5 py-0.5 text-[11px] rounded border border-red-500/40 text-red-400 hover:bg-red-500/10"
        title="Reject"
        @click.stop="emit('reject')"
      >
        ✗ Reject
      </button>
    </template>
    <button
      v-if="deletable !== false && !pending"
      class="opacity-0 group-hover:opacity-100 text-(--ui-text-muted) hover:text-red-400 shrink-0 mt-0.5"
      title="Удалить"
      @click.stop="emit('delete')"
    >
      <UIcon name="i-lucide-x" class="size-3.5" />
    </button>
  </div>
</template>
