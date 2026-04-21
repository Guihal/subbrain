<script setup lang="ts">
import type { MemoryTab } from "~/composables/useMemory";

const props = defineProps<{
  active: MemoryTab;
  search: string;
  agentFilter: string;
  agentIds: string[];
  logSessionFilter: string;
  logSessions: string[];
  page: number;
  pageCount: number;
}>();

const emit = defineEmits<{
  "update:search": [value: string];
  "update:agentFilter": [value: string];
  "update:logSessionFilter": [value: string];
  "update:page": [value: number];
  submit: [];
}>();

const searchable = computed(() =>
  ["shared", "context", "archive"].includes(props.active),
);
</script>

<template>
  <div
    class="px-4 py-2 border-b border-(--ui-border) flex flex-wrap items-center gap-2"
  >
    <UInput
      v-if="searchable"
      :model-value="search"
      placeholder="Поиск (FTS)…"
      icon="i-lucide-search"
      size="sm"
      class="flex-1 min-w-48"
      @update:model-value="emit('update:search', String($event))"
      @keydown.enter="emit('submit')"
    />
    <select
      v-if="active === 'agent'"
      :value="agentFilter"
      class="text-sm rounded border border-(--ui-border) bg-(--ui-bg) px-2 py-1"
      @change="emit('update:agentFilter', ($event.target as HTMLSelectElement).value)"
    >
      <option value="">Все агенты</option>
      <option v-for="id in agentIds" :key="id" :value="id">{{ id }}</option>
    </select>
    <select
      v-if="active === 'log'"
      :value="logSessionFilter"
      class="text-sm rounded border border-(--ui-border) bg-(--ui-bg) px-2 py-1 max-w-72"
      @change="emit('update:logSessionFilter', ($event.target as HTMLSelectElement).value)"
    >
      <option value="">Все сессии</option>
      <option v-for="s in logSessions" :key="s" :value="s">
        {{ s.slice(0, 28) }}
      </option>
    </select>

    <div class="ml-auto flex items-center gap-2 text-xs">
      <button
        class="px-2 py-1 rounded border border-(--ui-border) disabled:opacity-40"
        :disabled="page <= 1"
        @click="emit('update:page', page - 1)"
      >
        ←
      </button>
      <span>{{ page }} / {{ pageCount }}</span>
      <button
        class="px-2 py-1 rounded border border-(--ui-border) disabled:opacity-40"
        :disabled="page >= pageCount"
        @click="emit('update:page', page + 1)"
      >
        →
      </button>
    </div>
  </div>
</template>
