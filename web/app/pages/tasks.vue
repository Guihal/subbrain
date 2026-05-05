<script setup lang="ts">
const page = useTasksPage();
const {
  tasks: t,
  sidebarOpen,
  mode,
  historyItems,
  showForm,
  editingTask,
  confirmDelete,
  confirmCancel,
  showDelete,
  showCancel,
  hasQ,
  pageCount,
  switchMode,
  toggleScope,
  openNew,
  openEdit,
  onSubmit,
  doDelete,
  doCancel,
  handleStart,
  handleDone,
} = page;
</script>

<template>
  <div class="flex-1 flex flex-col min-w-0 overflow-hidden">
    <TasksToolbar
      v-model:sidebar-open="sidebarOpen"
      :search-query="t.filters.value.q"
      @update:search-query="t.setFilter('q', $event)"
      @open-new="openNew"
    />

    <TaskFilterBar
      :scope="t.filters.value.scope"
      :status="t.filters.value.status"
      :mode="mode"
      @toggle-scope="toggleScope"
      @set-status="(v: StatusFilter) => t.setFilter('status', v)"
      @switch-mode="switchMode"
    />

    <div
      v-if="t.error.value"
      class="px-4 py-2 bg-red-500/10 text-red-400 text-xs border-b border-red-500/30"
    >
      ⚠️ {{ t.error.value }}
    </div>

    <div class="flex-1 overflow-auto">
      <TaskListBody
        :mode="mode"
        :active-items="t.visibleItems.value"
        :history-items="historyItems"
        :loading="t.loading.value"
        @start="handleStart"
        @done="handleDone"
        @cancel="(task) => (confirmCancel = task)"
        @edit="openEdit"
        @delete="(task) => (confirmDelete = task)"
        @new-task="openNew"
      />
    </div>

    <TasksFooter
      :has-q="hasQ"
      :visible-count="t.visibleItems.value.length"
      :total-items-count="t.items.value.length"
      :page="t.filters.value.page"
      :page-count="pageCount"
      :loading="t.loading.value"
      @prev="t.setFilter('page', t.filters.value.page - 1)"
      @next="t.setFilter('page', t.filters.value.page + 1)"
    />

    <TaskFormModal v-model="showForm" :task="editingTask" @submit="onSubmit" />

    <TaskConfirmModal
      v-model="showDelete"
      title="Удалить задачу?"
      message="Отменить нельзя. Задача будет удалена из базы."
      confirm-label="Удалить"
      confirm-color="error"
      @confirm="confirmDelete && doDelete(confirmDelete)"
    />

    <TaskConfirmModal
      v-model="showCancel"
      title="Отменить задачу?"
      message="Задача перейдёт в статус cancelled. Открыть заново нельзя."
      confirm-label="Отменить задачу"
      confirm-color="warning"
      @confirm="confirmCancel && doCancel(confirmCancel)"
    />
  </div>
</template>
