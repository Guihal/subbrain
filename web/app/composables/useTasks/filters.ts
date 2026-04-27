import { computed, type Ref } from "vue";
import type { TaskFilters, TaskRow } from "~/types/task";

export type TaskFiltersDeps = {
  filters: Ref<TaskFilters>;
  items: Ref<TaskRow[]>;
};

export function createTaskFilters(deps: TaskFiltersDeps) {
  const { filters, items } = deps;

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

  return { visibleItems, setFilter, resetPage };
}
