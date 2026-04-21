<script setup lang="ts">
import type { MemoryRow } from "~/composables/useMemory";

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
  loadActive,
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
});

watch([page, agentFilter, logSessionFilter], () => {
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

      <MemoryTabs :active="activeTab" @switch="switchTab" />

      <MemoryFilterBar
        :active="activeTab"
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
        <MemoryList
          :active="activeTab"
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
