<script setup lang="ts">
import type {
  ExtendedMemoryTab,
  MemoryKind,
  MemoryTab,
  PendingLayer,
} from "~/composables/useMemory";

defineProps<{
  activeTab: ExtendedMemoryTab;
  totalForActive: number;
  loading: boolean;
  pendingCount: number;
  pendingTotal: number;
  search: string;
  agentFilter: string;
  agentIds: string[];
  logSessionFilter: string;
  logSessions: string[];
  page: number;
  pageCount: number;
}>();

const sidebarOpen = defineModel<boolean>("sidebarOpen", { required: true });
const pendingLayer = defineModel<PendingLayer>("pendingLayer", { required: true });
const kindFilter = defineModel<MemoryKind | "">("kindFilter", { required: true });

const emit = defineEmits<{
  switchTab: [tab: ExtendedMemoryTab];
  submitSearch: [];
  "update:search": [value: string];
  "update:agentFilter": [value: string];
  "update:logSessionFilter": [value: string];
  "update:page": [value: number];
}>();
</script>

<template>
  <div>
    <div
      class="h-12 border-b border-(--ui-border) flex items-center gap-2 px-4"
    >
      <UButton
        icon="i-lucide-menu"
        variant="ghost"
        size="sm"
        class="md:hidden"
        @click="sidebarOpen = !sidebarOpen"
      />
      <span class="text-lg">🧠 Память</span>
      <span class="text-xs text-(--ui-text-muted) ml-auto">
        {{ totalForActive }} записей
        <span v-if="loading" class="ml-2">· загрузка…</span>
      </span>
    </div>

    <div class="flex border-b border-(--ui-border) text-sm">
      <MemoryTabs
        :active="(activeTab === 'pending' ? 'shared' : activeTab) as MemoryTab"
        class="flex-1"
        @switch="emit('switchTab', $event)"
      />
      <button
        class="px-3 py-2 transition-colors border-l border-(--ui-border)"
        :class="
          activeTab === 'pending'
            ? 'text-(--ui-text) border-b-2 border-(--ui-primary)'
            : 'text-(--ui-text-muted) hover:text-(--ui-text)'
        "
        @click="emit('switchTab', 'pending')"
      >
        ⏳ Pending
        <span
          v-if="pendingCount > 0"
          class="ml-1 px-1.5 py-0.5 text-[10px] rounded bg-(--ui-primary) text-(--ui-bg)"
        >{{ pendingCount }}</span>
      </button>
    </div>

    <div
      v-if="activeTab === 'pending'"
      class="px-4 py-2 border-b border-(--ui-border) flex items-center gap-2 text-xs"
    >
      <span class="text-(--ui-text-muted)">Слой:</span>
      <select
        :value="pendingLayer"
        class="text-sm rounded border border-(--ui-border) bg-(--ui-bg) px-2 py-1"
        @change="pendingLayer = ($event.target as HTMLSelectElement).value as PendingLayer"
      >
        <option value="shared">Shared</option>
        <option value="context">Context</option>
      </select>
      <span class="ml-auto">{{ pendingTotal }} pending</span>
    </div>

    <div
      v-if="activeTab === 'shared'"
      class="px-4 py-2 border-b border-(--ui-border) flex items-center gap-2 text-xs"
    >
      <span class="text-(--ui-text-muted)">Kind:</span>
      <select
        :value="kindFilter"
        class="text-sm rounded border border-(--ui-border) bg-(--ui-bg) px-2 py-1"
        @change="kindFilter = ($event.target as HTMLSelectElement).value as (MemoryKind | '')"
      >
        <option value="">Все</option>
        <option value="persona">persona</option>
        <option value="semantic">semantic</option>
        <option value="episodic">episodic</option>
        <option value="procedural">procedural</option>
      </select>
    </div>

    <MemoryFilterBar
      v-if="activeTab !== 'pending'"
      :active="activeTab as MemoryTab"
      :search="search"
      :agent-filter="agentFilter"
      :agent-ids="agentIds"
      :log-session-filter="logSessionFilter"
      :log-sessions="logSessions"
      :page="page"
      :page-count="pageCount"
      @update:search="emit('update:search', $event)"
      @update:agent-filter="emit('update:agentFilter', $event)"
      @update:log-session-filter="emit('update:logSessionFilter', $event)"
      @update:page="emit('update:page', $event)"
      @submit="emit('submitSearch')"
    />
  </div>
</template>
