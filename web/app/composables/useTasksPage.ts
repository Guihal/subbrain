// Page-local state + handlers for /tasks (split from pages/tasks.vue, W1-5).
// Owns history items/total, mode, modal flags, derived showDelete/showCancel/
// hasQ/pageCount, lifecycle. Wraps useTasks() so the page renders against a
// flat object. Every mutation goes through wrap() → mode-aware reload; errors
// surface via tasks.error banner.
import type {
  CreateBody,
  HistoryItem,
  PatchBody,
  TaskRow,
  TaskScope,
} from "~/types/task";

export function useTasksPage() {
  const tasks = useTasks();
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
    set: (v) => { if (!v) confirmDelete.value = null; },
  });
  const showCancel = computed({
    get: () => confirmCancel.value !== null,
    set: (v) => { if (!v) confirmCancel.value = null; },
  });
  const hasQ = computed(() => tasks.filters.value.q.trim() !== "");
  const pageCount = computed(() => {
    const totalN = mode.value === "active" ? tasks.total.value : historyTotal.value;
    return Math.max(1, Math.ceil(totalN / tasks.filters.value.page_size));
  });

  async function loadHistory(): Promise<void> {
    const env = await tasks.history();
    historyItems.value = env.items;
    historyTotal.value = env.total;
  }

  async function dispatch(): Promise<void> {
    if (mode.value === "active") await tasks.refresh();
    else await loadHistory();
  }

  async function wrap(fn: () => Promise<unknown>): Promise<void> {
    try { await fn(); await dispatch(); } catch { /* banner */ }
  }

  function switchMode(m: "active" | "history"): void {
    mode.value = m;
    tasks.resetPage();
  }

  function toggleScope(s: TaskScope) {
    tasks.setFilter("scope", tasks.filters.value.scope === s ? undefined : s);
  }

  function openNew() { editingTask.value = null; showForm.value = true; }
  function openEdit(task: TaskRow) { editingTask.value = task; showForm.value = true; }

  function onSubmit(body: CreateBody | PatchBody, isEdit: boolean) {
    void wrap(async () => {
      if (isEdit && editingTask.value)
        await tasks.update(editingTask.value.id, body as PatchBody);
      else
        await tasks.create(body as CreateBody);
      showForm.value = false;
      editingTask.value = null;
    });
  }

  function doDelete(task: TaskRow) {
    void wrap(() => tasks.remove(task.id))
      .finally(() => { confirmDelete.value = null; });
  }
  function doCancel(task: TaskRow) {
    void wrap(() => tasks.cancel(task.id))
      .finally(() => { confirmCancel.value = null; });
  }

  const handleStart = (task: TaskRow) => wrap(() => tasks.start(task.id));
  const handleDone = (task: TaskRow) => wrap(() => tasks.done(task.id));

  onMounted(() => { void dispatch(); });

  watch(
    () => [
      mode.value,
      tasks.filters.value.scope,
      tasks.filters.value.status,
      tasks.filters.value.page,
      tasks.filters.value.page_size,
    ],
    () => void dispatch(),
  );

  return {
    tasks, sidebarOpen, mode, historyItems,
    showForm, editingTask, confirmDelete, confirmCancel,
    showDelete, showCancel, hasQ, pageCount,
    switchMode, toggleScope, openNew, openEdit,
    onSubmit, doDelete, doCancel, handleStart, handleDone,
  };
}
