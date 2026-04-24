<script setup lang="ts">
import type { MemoryRow, MemoryTab } from "~/composables/useMemory";

const memory = useMemory();
const {
  activeTab,
  search,
  page,
  pageSize,
  focus,
  shared,
  context,
  archive,
  agent,
  agentIds,
  agentFilter,
  log,
  logSessions,
  logSessionFilter,
  selected,
  loading,
  error,
  totalForActive,
  // PR 22b pending
  pending,
  pendingLayer,
  pendingCount,
  loadActive,
  refreshPendingCount,
  switchTab,
  select,
  saveFocus,
  deleteFocus,
  saveShared,
  deleteShared,
  saveContext,
  deleteContext,
  saveArchive,
  deleteArchive,
  saveAgent,
  deleteAgent,
  approveMemory,
  rejectMemory,
} = memory;

const sidebarOpen = useState("sidebar-open", () => false);
const confirmDelete = ref<MemoryRow | null>(null);
const showDelete = computed({
  get: () => confirmDelete.value !== null,
  set: (v) => {
    if (!v) confirmDelete.value = null;
  },
});

const pageCount = computed(() =>
  Math.max(1, Math.ceil(totalForActive.value / pageSize.value)),
);

onMounted(() => {
  loadActive();
  refreshPendingCount();
});

watch([page, agentFilter, logSessionFilter, pendingLayer], () => {
  loadActive();
});

function onSearchSubmit() {
  page.value = 1;
  loadActive();
}

async function handleDelete(row: MemoryRow) {
  switch (row.__kind) {
    case "focus":
      await deleteFocus(row.key);
      break;
    case "shared":
      await deleteShared(row.id);
      break;
    case "context":
      await deleteContext(row.id);
      break;
    case "archive":
      await deleteArchive(row.id);
      break;
    case "agent":
      await deleteAgent(row.id);
      break;
  }
  confirmDelete.value = null;
}
</script>

<template>
  <div class="flex-1 flex flex-col min-w-0">
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
        <MemoryTabs :active="(activeTab === 'pending' ? 'shared' : activeTab) as MemoryTab" class="flex-1" @switch="switchTab" />
        <button
          class="px-3 py-2 transition-colors border-l border-(--ui-border)"
          :class="activeTab === 'pending' ? 'text-(--ui-text) border-b-2 border-(--ui-primary)' : 'text-(--ui-text-muted) hover:text-(--ui-text)'"
          @click="switchTab('pending')"
        >
          ⏳ Pending
          <span v-if="pendingCount > 0" class="ml-1 px-1.5 py-0.5 text-[10px] rounded bg-(--ui-primary) text-(--ui-bg)">{{ pendingCount }}</span>
        </button>
      </div>

      <div v-if="activeTab === 'pending'" class="px-4 py-2 border-b border-(--ui-border) flex items-center gap-2 text-xs">
        <span class="text-(--ui-text-muted)">Слой:</span>
        <select
          :value="pendingLayer"
          class="text-sm rounded border border-(--ui-border) bg-(--ui-bg) px-2 py-1"
          @change="pendingLayer = ($event.target as HTMLSelectElement).value as 'shared' | 'context'"
        >
          <option value="shared">Shared</option>
          <option value="context">Context</option>
        </select>
        <span class="ml-auto">{{ pending.total }} pending</span>
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
        @update:search="search = $event"
        @update:agent-filter="agentFilter = $event"
        @update:log-session-filter="logSessionFilter = $event"
        @update:page="page = $event"
        @submit="onSearchSubmit"
      />

      <div
        v-if="error"
        class="px-4 py-2 bg-red-500/10 text-red-400 text-xs border-b border-red-500/30"
      >
        ⚠️ {{ error }}
      </div>

      <div class="flex-1 flex overflow-hidden">
        <template v-if="activeTab === 'pending'">
          <div class="flex-1 overflow-y-auto">
            <MemoryRow
              v-for="row in pending.items"
              :key="row.id"
              :row="{ __kind: pendingLayer, ...(row as any) } as MemoryRow"
              :pending="row.status === 'pending'"
              :title="(row as any).title ?? row.content.slice(0, 80)"
              :badge="pendingLayer"
              :badge-color="pendingLayer === 'shared' ? 'text-blue-400' : 'text-purple-400'"
              :ts="row.updated_at"
              :deletable="false"
              @approve="approveMemory(pendingLayer, row.id)"
              @reject="rejectMemory(pendingLayer, row.id)"
            />
            <div
              v-if="pending.total === 0 && !loading"
              class="text-center text-(--ui-text-dimmed) text-sm py-10"
            >
              Нет записей, ожидающих подтверждения.
            </div>
          </div>
        </template>
        <template v-else>
          <MemoryList
            :active="(activeTab as MemoryTab)"
            :selected="selected"
            :focus="focus"
            :shared="shared"
            :context="context"
            :archive="archive"
            :agent="agent"
            :log="log"
            :total="totalForActive"
            :loading="loading"
            @select="select($event)"
            @delete="confirmDelete = $event"
          />

          <MemoryEditor
            v-if="selected"
            :selected="selected"
            @close="select(null)"
            @delete="confirmDelete = $event"
            @save-focus="(key, value) => saveFocus(key, value)"
            @save-shared="(id, patch) => saveShared(id, patch)"
            @save-context="(id, patch) => saveContext(id, patch)"
            @save-archive="(id, patch) => saveArchive(id, patch)"
            @save-agent="(id, patch) => saveAgent(id, patch)"
          />
        </template>
      </div>

      <UModal v-model:open="showDelete" title="Удалить запись?">
        <template #body>
          <p class="text-sm text-(--ui-text-muted)">
            Отменить нельзя. Запись будет удалена из памяти.
          </p>
        </template>
        <template #footer>
          <div class="flex gap-2 justify-end">
            <UButton
              variant="ghost"
              label="Отмена"
              @click="confirmDelete = null"
            />
            <UButton
              color="error"
              label="Удалить"
              @click="confirmDelete && handleDelete(confirmDelete)"
            />
          </div>
        </template>
    </UModal>
  </div>
</template>
