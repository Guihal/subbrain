/**
 * Memory admin composable — backs the /memory page.
 *
 * State is shared across mounts via useState so switching tabs keeps
 * loaded lists (no refetch churn). All mutations go through api() which
 * injects the Bearer token via useApi().
 *
 * Structure:
 * - Types + LAYER_SCHEMAS live in `useMemory/types.ts`.
 * - List-style layers (shared/context/archive/agent/log) use the factory
 *   `useMemoryLayer` from `useMemory/layer.ts`.
 * - Layer 1 (focus, KV shape) lives in `useMemoryFocus` from `useMemory/focus.ts`.
 */

export type {
  MemoryTab,
  ListLayer,
  FocusEntry,
  SharedRow,
  ContextRow,
  ArchiveRow,
  AgentMemRow,
  LogRow,
  MemoryRow,
  MemoryKind,
} from "./useMemory/types";
export { LAYER_SCHEMAS } from "./useMemory/types";

import type {
  MemoryTab,
  MemoryRow,
  SharedRow,
  ContextRow,
  ArchiveRow,
  AgentMemRow,
  LogRow,
  MemoryKind,
} from "./useMemory/types";
import { useMemoryLayer, type LayerDeps } from "./useMemory/layer";
import { useMemoryFocus } from "./useMemory/focus";

// PR 22b: extended tab adds "pending" — pending rows from shared + context
// with status='pending' awaiting human approve/reject. The underlying
// MemoryTab union lives in useMemory/types.ts (not in PR 22b allow-list),
// so we widen here and cast at subcomponent boundaries.
export type ExtendedMemoryTab = MemoryTab | "pending";
export type PendingLayer = "shared" | "context";
export type PendingRow = (SharedRow | ContextRow) & {
  status?: "pending" | "active" | "rejected";
};

export function useMemory() {
  const { api } = useApi();

  const activeTab = useState<ExtendedMemoryTab>("memory-tab", () => "shared");
  const search = useState<string>("memory-search", () => "");
  const page = useState<number>("memory-page", () => 1);
  const pageSize = useState<number>("memory-page-size", () => 50);

  const agentIds = useState<string[]>("memory-agent-ids", () => []);
  const agentFilter = useState<string>("memory-agent-filter", () => "");
  const logSessions = useState<string[]>("memory-log-sessions", () => []);
  const logSessionFilter = useState<string>(
    "memory-log-session-filter",
    () => "",
  );

  const selected = useState<MemoryRow | null>("memory-selected", () => null);
  const loading = useState<boolean>("memory-loading", () => false);
  const error = useState<string | null>("memory-error", () => null);

  const deps: LayerDeps = { api, loading, error, selected };
  const { focus, loadFocus, saveFocus, deleteFocus } = useMemoryFocus(deps);

  const stdQuery = () => ({
    limit: pageSize.value,
    offset: (page.value - 1) * pageSize.value,
    q: search.value || undefined,
  });

  // M-07: shared-only kind filter. "" = "all" (filter omitted from query).
  const kindFilter = useState<MemoryKind | "">("memory-shared-kind", () => "");
  const sharedL = useMemoryLayer<SharedRow>("shared", deps, {
    buildQuery: () => ({
      ...stdQuery(),
      kind: kindFilter.value || undefined,
    }),
  });
  const contextL = useMemoryLayer<ContextRow>("context", deps, { buildQuery: stdQuery });
  const archiveL = useMemoryLayer<ArchiveRow>("archive", deps, { buildQuery: stdQuery });
  const agentL = useMemoryLayer<AgentMemRow>("agent", deps, {
    buildQuery: () => ({
      limit: pageSize.value,
      offset: (page.value - 1) * pageSize.value,
      agent_id: agentFilter.value || undefined,
    }),
    onAfterLoad: async () => {
      agentIds.value = await api<string[]>("/v1/memory/agent/agents");
    },
  });
  const logL = useMemoryLayer<LogRow>("log", deps, {
    readonly: true,
    buildQuery: () => ({
      limit: pageSize.value,
      offset: (page.value - 1) * pageSize.value,
      session_id: logSessionFilter.value || undefined,
    }),
    onAfterLoad: async () => {
      logSessions.value = await api<string[]>("/v1/memory/log/sessions?limit=50");
    },
  });

  // ─── PR 22b: pending approval state ───────────────────────
  const pendingLayer = useState<PendingLayer>("memory-pending-layer", () => "shared");
  const pending = useState<{ items: PendingRow[]; total: number }>(
    "memory-pending",
    () => ({ items: [], total: 0 }),
  );
  const pendingCount = useState<number>("memory-pending-count", () => 0);

  async function loadPending() {
    loading.value = true;
    error.value = null;
    try {
      const limit = pageSize.value;
      const offset = (page.value - 1) * pageSize.value;
      const data = await api<{ items: PendingRow[]; total: number }>(
        `/v1/memory/pending?layer=${pendingLayer.value}&limit=${limit}&offset=${offset}`,
      );
      pending.value = data;
    } catch (e) {
      error.value = (e as Error).message;
    } finally {
      loading.value = false;
    }
  }

  async function refreshPendingCount() {
    try {
      const [s, c] = await Promise.all([
        api<{ total: number }>("/v1/memory/pending?layer=shared&limit=1"),
        api<{ total: number }>("/v1/memory/pending?layer=context&limit=1"),
      ]);
      pendingCount.value = (s?.total ?? 0) + (c?.total ?? 0);
    } catch {
      /* silent: counter is decorative */
    }
  }

  async function setPendingStatus(
    layer: PendingLayer,
    id: string,
    status: "active" | "rejected",
  ) {
    await api(`/v1/memory/${layer}/${id}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    });
    await loadPending();
    await refreshPendingCount();
  }

  const approveMemory = (layer: PendingLayer, id: string) =>
    setPendingStatus(layer, id, "active");
  const rejectMemory = (layer: PendingLayer, id: string) =>
    setPendingStatus(layer, id, "rejected");

  const totalForActive = computed(() => {
    switch (activeTab.value) {
      case "focus": return focus.value.length;
      case "shared": return sharedL.state.value.total;
      case "context": return contextL.state.value.total;
      case "archive": return archiveL.state.value.total;
      case "agent": return agentL.state.value.total;
      case "log": return logL.state.value.total;
      case "pending": return pending.value.total;
    }
  });

  async function loadActive() {
    switch (activeTab.value) {
      case "focus": return loadFocus();
      case "shared": return sharedL.load();
      case "context": return contextL.load();
      case "archive": return archiveL.load();
      case "agent": return agentL.load();
      case "log": return logL.load();
      case "pending": return loadPending();
    }
  }

  function switchTab(tab: ExtendedMemoryTab) {
    activeTab.value = tab;
    selected.value = null;
    search.value = "";
    page.value = 1;
    void loadActive();
  }

  function select(row: MemoryRow | null) {
    selected.value = row;
  }

  return {
    // state
    activeTab, search, page, pageSize,
    focus,
    // M-07: shared kind filter exposed for the UI dropdown.
    kindFilter,
    shared: sharedL.state,
    context: contextL.state,
    archive: archiveL.state,
    agent: agentL.state,
    log: logL.state,
    agentIds, agentFilter, logSessions, logSessionFilter,
    selected, loading, error, totalForActive,
    // PR 22b pending state
    pending, pendingLayer, pendingCount,
    // loaders
    loadFocus,
    loadShared: sharedL.load,
    loadContext: contextL.load,
    loadArchive: archiveL.load,
    loadAgent: agentL.load,
    loadLog: logL.load,
    loadPending, refreshPendingCount,
    loadActive, switchTab, select,
    // mutations
    saveFocus, deleteFocus,
    saveShared: sharedL.save,
    deleteShared: sharedL.remove,
    saveContext: contextL.save,
    deleteContext: contextL.remove,
    saveArchive: archiveL.save,
    deleteArchive: archiveL.remove,
    saveAgent: agentL.save,
    deleteAgent: agentL.remove,
    approveMemory, rejectMemory,
  };
}
