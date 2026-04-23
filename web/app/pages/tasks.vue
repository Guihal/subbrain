<script setup lang="ts">
import type {
  CreateBody,
  HistoryItem,
  PatchBody,
  StatusFilter,
  TaskRow,
  TaskScope,
} from "~/types/task";

const t = useTasks();
const sidebarOpen = useState("sidebar-open", () => false);
const mode = useState<"active" | "history">("tasks.mode", () => "active");

const historyItems = ref<HistoryItem[]>([]);
const historyTotal = ref(0);
const showForm = ref(false);
const editingTask = ref<TaskRow | null>(null);
const confirmDelete = ref<TaskRow | null>(null);
const confirmCancel = ref<TaskRow | null>(null);

const showDelete = computed({
  get: () => confirmDelete.value !== null,
  set: (v) => {
    if (!v) confirmDelete.value = null;
  },
});
const showCancel = computed({
  get: () => confirmCancel.value !== null,
  set: (v) => {
    if (!v) confirmCancel.value = null;
  },
});

async function loadHistory(): Promise<void> {
  const env = await t.history();
  historyItems.value = env.items;
  historyTotal.value = env.total;
}

function switchMode(m: "active" | "history"): void {
  // Dispatch is handled by the watcher below, which observes `mode` and
  // `filters`. Changing either triggers a single mode-aware fetch.
  mode.value = m;
  t.resetPage();
}

function toggleScope(s: TaskScope) {
  t.setFilter("scope", t.filters.value.scope === s ? undefined : s);
}

function openNew() {
  editingTask.value = null;
  showForm.value = true;
}

function openEdit(task: TaskRow) {
  editingTask.value = task;
  showForm.value = true;
}

// Every mutation must be followed by a mode-aware reload (dispatch()).
// Errors surface via t.error banner — swallow here to avoid unhandled
// rejections in event handlers.
async function wrap(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    await dispatch();
  } catch {
    /* banner */
  }
}

function onSubmit(body: CreateBody | PatchBody, isEdit: boolean) {
  void wrap(async () => {
    if (isEdit && editingTask.value) {
      await t.update(editingTask.value.id, body as PatchBody);
    } else {
      await t.create(body as CreateBody);
    }
    showForm.value = false;
    editingTask.value = null;
  });
}

function doDelete(task: TaskRow) {
  void wrap(() => t.remove(task.id)).finally(() => {
    confirmDelete.value = null;
  });
}

function doCancel(task: TaskRow) {
  void wrap(() => t.cancel(task.id)).finally(() => {
    confirmCancel.value = null;
  });
}

const handleStart = (task: TaskRow) => wrap(() => t.start(task.id));
const handleDone = (task: TaskRow) => wrap(() => t.done(task.id));

const hasQ = computed(() => t.filters.value.q.trim() !== "");
const pageCount = computed(() => {
  const totalN = mode.value === "active" ? t.total.value : historyTotal.value;
  return Math.max(1, Math.ceil(totalN / t.filters.value.page_size));
});

async function dispatch(): Promise<void> {
  if (mode.value === "active") await t.refresh();
  else await loadHistory();
}

onMounted(() => {
  // Respect persisted mode from useState("tasks.mode") — if the user
  // left this page while viewing history, restore to history on mount
  // instead of landing on an empty «История пуста» (historyItems is a
  // local ref and resets between mounts).
  void dispatch();
});

// Single dispatcher for all fetch-triggering state. `q` is excluded —
// it's a client-side filter over already-loaded items.
watch(
  () => [
    mode.value,
    t.filters.value.scope,
    t.filters.value.status,
    t.filters.value.page,
    t.filters.value.page_size,
  ],
  () => void dispatch(),
);
</script>

<template>
  <div class="flex-1 flex flex-col min-w-0 overflow-hidden">
    <header
      class="h-12 border-b border-(--ui-border) flex items-center gap-2 px-4 shrink-0"
    >
      <UButton
        icon="i-lucide-menu"
        variant="ghost"
        size="sm"
        class="md:hidden"
        @click="sidebarOpen = !sidebarOpen"
      />
      <span class="text-lg">📋 Задачи</span>
      <input
        :value="t.filters.value.q"
        placeholder="Поиск по странице…"
        class="ml-3 px-2 py-1 text-sm bg-(--ui-bg) border border-(--ui-border) rounded"
        @input="t.setFilter('q', ($event.target as HTMLInputElement).value)"
      >
      <div class="ml-auto">
        <UButton icon="i-lucide-plus" label="Новая" size="sm" @click="openNew" />
      </div>
    </header>

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

    <footer
      class="flex items-center gap-2 px-4 py-2 border-t border-(--ui-border) text-xs"
    >
      <template v-if="hasQ">
        <span class="text-(--ui-text-muted)">
          Поиск по странице: {{ t.visibleItems.value.length }} из
          {{ t.items.value.length }}. Для полного поиска очисти запрос.
        </span>
      </template>
      <template v-else>
        <button
          :disabled="t.filters.value.page <= 1"
          class="px-2 py-1"
          @click="t.setFilter('page', t.filters.value.page - 1)"
        >
          ←
        </button>
        <span>Стр. {{ t.filters.value.page }} / {{ pageCount }}</span>
        <button
          :disabled="t.filters.value.page >= pageCount"
          class="px-2 py-1"
          @click="t.setFilter('page', t.filters.value.page + 1)"
        >
          →
        </button>
      </template>
      <span v-if="t.loading.value" class="ml-auto text-(--ui-text-muted)">
        загрузка…
      </span>
    </footer>

    <TaskFormModal
      v-model="showForm"
      :task="editingTask"
      @submit="onSubmit"
    />

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

