/**
 * Tasks composable — backs /tasks page. Follows useFreelance/useMemory
 * shape: useState-shared + api() for mutations.
 *
 * The backend does not accept a `q` search parameter, so `filters.q`
 * triggers a client-side substring filter over `items` of the current
 * page (see `visibleItems`). When `q` is active the UI should hide
 * pagination (see pages/tasks.vue) because `total` does not reflect the
 * filter.
 */
import type {
  CreateBody,
  HistoryItem,
  ListEnvelope,
  PatchBody,
  TaskFilters,
  TaskRow,
} from "~/types/task";

export function useTasks() {
  const { api } = useApi();

  const items = useState<TaskRow[]>("tasks.items", () => []);
  const total = useState<number>("tasks.total", () => 0);
  const loading = useState<boolean>("tasks.loading", () => false);
  const error = useState<string | null>("tasks.error", () => null);
  const filters = useState<TaskFilters>("tasks.filters", () => ({
    scope: undefined,
    status: "active",
    page: 1,
    page_size: 20,
    q: "",
  }));

  function buildParams(): URLSearchParams {
    const p = new URLSearchParams();
    if (filters.value.scope) p.set("scope", filters.value.scope);
    if (filters.value.status !== "all") p.set("status", filters.value.status);
    p.set("page", String(filters.value.page));
    p.set("page_size", String(filters.value.page_size));
    return p;
  }

  function captureError(e: unknown): string {
    const anyE = e as {
      data?: { error?: { message?: string } };
      message?: string;
    };
    return anyE.data?.error?.message ?? anyE.message ?? "unknown error";
  }

  async function refresh(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const env = await api<ListEnvelope<TaskRow>>(
        `/v1/tasks?${buildParams().toString()}`,
      );
      items.value = env.items;
      total.value = env.total;
    } catch (e) {
      error.value = captureError(e);
    } finally {
      loading.value = false;
    }
  }

  // Mutations do NOT auto-reload. The consuming page owns the mode-aware
  // dispatcher and should call it after any mutation — otherwise a
  // refresh() here would hit /v1/tasks even in history mode, mutate
  // `items` behind the back of the UI, and leave `historyItems` stale.
  async function create(body: CreateBody): Promise<TaskRow> {
    try {
      return await api<TaskRow>("/v1/tasks", { method: "POST", body });
    } catch (e) {
      error.value = captureError(e);
      throw e;
    }
  }

  async function update(id: string, patch: PatchBody): Promise<TaskRow> {
    try {
      return await api<TaskRow>(`/v1/tasks/${id}`, {
        method: "PATCH",
        body: patch,
      });
    } catch (e) {
      error.value = captureError(e);
      throw e;
    }
  }

  async function remove(id: string): Promise<void> {
    try {
      await api(`/v1/tasks/${id}`, { method: "DELETE" });
    } catch (e) {
      error.value = captureError(e);
      throw e;
    }
  }

  const start = (id: string) => update(id, { status: "in_progress" });
  const done = (id: string) => update(id, { status: "done" });
  const cancel = (id: string) => update(id, { status: "cancelled" });

  async function history(): Promise<ListEnvelope<HistoryItem>> {
    const p = new URLSearchParams();
    if (filters.value.scope) p.set("scope", filters.value.scope);
    p.set("page", String(filters.value.page));
    p.set("page_size", String(filters.value.page_size));
    return api<ListEnvelope<HistoryItem>>(`/v1/tasks/history?${p.toString()}`);
  }

  const visibleItems = computed(() => {
    const q = filters.value.q.trim().toLowerCase();
    if (!q) return items.value;
    return items.value.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q),
    );
  });

  /**
   * setFilter mutates state ONLY. It does not fetch.
   *
   * Dispatch is owned by the consuming page (tasks.vue), which has a
   * single mode-aware watcher on `filters` that calls refresh() for
   * active mode or the history loader for history mode. Putting fetch
   * logic here would either duplicate the watcher or hit the wrong
   * endpoint when the page is in history mode.
   *
   * `q` preserves page (client-side filter — typing shouldn't jump
   * pages); everything else resets page=1.
   */
  function setFilter<K extends keyof TaskFilters>(
    key: K,
    val: TaskFilters[K],
  ): void {
    const next: TaskFilters = { ...filters.value, [key]: val };
    if (key !== "q" && key !== "page") next.page = 1;
    filters.value = next;
  }

  function resetPage(): void {
    filters.value = { ...filters.value, page: 1 };
  }

  return {
    items,
    visibleItems,
    total,
    loading,
    error,
    filters,
    refresh,
    create,
    update,
    remove,
    start,
    done,
    cancel,
    history,
    setFilter,
    resetPage,
  };
}
