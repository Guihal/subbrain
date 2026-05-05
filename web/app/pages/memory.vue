<script setup lang="ts">
const memory = useMemory();
const {
  activeTab,
  search,
  page,
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
  kindFilter,
  selected,
  loading,
  error,
  totalForActive,
  pending,
  pendingLayer,
  pendingCount,
  switchTab,
  select,
  saveFocus,
  saveShared,
  saveContext,
  saveArchive,
  saveAgent,
  approveMemory,
  rejectMemory,
} = memory;

const sidebarOpen = useState("sidebar-open", () => false);

const { confirmDelete, showDelete, pageCount, onSearchSubmit, handleDelete } =
  useMemoryPage(memory);
</script>

<template>
  <div class="flex-1 flex flex-col min-w-0">
    <MemoryToolbar
      v-model:sidebar-open="sidebarOpen"
      v-model:pending-layer="pendingLayer"
      v-model:kind-filter="kindFilter"
      :active-tab="activeTab"
      :total-for-active="totalForActive"
      :loading="loading"
      :pending-count="pendingCount"
      :pending-total="pending.total"
      :search="search"
      :agent-filter="agentFilter"
      :agent-ids="agentIds"
      :log-session-filter="logSessionFilter"
      :log-sessions="logSessions"
      :page="page"
      :page-count="pageCount"
      @switch-tab="switchTab"
      @submit-search="onSearchSubmit"
      @update:search="search = $event"
      @update:agent-filter="agentFilter = $event"
      @update:log-session-filter="logSessionFilter = $event"
      @update:page="page = $event"
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

    <MemoryDeleteModal
      v-model:open="showDelete"
      :row="confirmDelete"
      @cancel="confirmDelete = null"
      @confirm="handleDelete"
    />
  </div>
</template>
