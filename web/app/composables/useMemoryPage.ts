/**
 * Page-local helpers for /memory — split out of pages/memory.vue (W1-4).
 *
 * Wraps useMemory()'s flat surface with page-specific reactive state:
 *   - confirmDelete / showDelete (UModal v-model bridge)
 *   - pageCount (derived from totalForActive + pageSize)
 *   - onSearchSubmit (resets page, reloads)
 *   - handleDelete (dispatches by row.__kind)
 *   - onMounted: initial loadActive + refreshPendingCount
 *   - watch: reload on page/agentFilter/logSessionFilter/pendingLayer/kindFilter changes
 *
 * Design: composable receives the full useMemory() return-value to avoid a
 * second call (which would create a fresh state graph). It does not own
 * loaders or mutations — only page-shell concerns.
 */
import type { MemoryRow } from "~/composables/useMemory";

type MemoryApi = ReturnType<typeof useMemory>;

export function useMemoryPage(memory: MemoryApi) {
  const {
    page,
    pageSize,
    totalForActive,
    agentFilter,
    logSessionFilter,
    pendingLayer,
    kindFilter,
    loadActive,
    refreshPendingCount,
    deleteFocus,
    deleteShared,
    deleteContext,
    deleteArchive,
    deleteAgent,
  } = memory;

  const confirmDelete = ref<MemoryRow | null>(null);
  const showDelete = computed({
    get: () => confirmDelete.value !== null,
    set: (v) => {
      if (!v) confirmDelete.value = null;
    },
  });

  const pageCount = computed(() => Math.max(1, Math.ceil(totalForActive.value / pageSize.value)));

  onMounted(() => {
    loadActive();
    refreshPendingCount();
  });

  watch([page, agentFilter, logSessionFilter, pendingLayer, kindFilter], () => {
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

  return { confirmDelete, showDelete, pageCount, onSearchSubmit, handleDelete };
}
