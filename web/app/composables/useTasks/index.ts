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
import type { TaskFilters, TaskRow } from "~/types/task";
import { createTaskApi } from "./api";
import { createTaskFilters } from "./filters";

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

  const { refresh, create, update, remove, start, done, cancel, history } = createTaskApi({
    api,
    items,
    total,
    loading,
    error,
    filters,
  });
  const { visibleItems, setFilter, resetPage } = createTaskFilters({
    filters,
    items,
  });

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
