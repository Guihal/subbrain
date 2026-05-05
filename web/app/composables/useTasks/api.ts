import type { Ref } from "vue";
import type {
  CreateBody,
  HistoryItem,
  ListEnvelope,
  PatchBody,
  TaskFilters,
  TaskRow,
} from "~/types/task";

type ApiFn = ReturnType<typeof useApi>["api"];

export type TaskApiDeps = {
  api: ApiFn;
  items: Ref<TaskRow[]>;
  total: Ref<number>;
  loading: Ref<boolean>;
  error: Ref<string | null>;
  filters: Ref<TaskFilters>;
};

function buildParams(filters: Ref<TaskFilters>): URLSearchParams {
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

export function createTaskApi(deps: TaskApiDeps) {
  const { api, items, total, loading, error, filters } = deps;

  async function refresh(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const env = await api<ListEnvelope<TaskRow>>(`/v1/tasks?${buildParams(filters).toString()}`);
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

  return { refresh, create, update, remove, start, done, cancel, history };
}
