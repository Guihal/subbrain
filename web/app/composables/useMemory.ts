/**
 * Memory admin composable — backs the /memory page.
 *
 * State is shared across mounts via useState so switching tabs keeps
 * loaded lists (no refetch churn). All mutations go through api() which
 * injects the Bearer token via useApi().
 *
 * Structure: list-style layers (shared/context/archive/agent/log) are
 * built via the internal `useMemoryLayer` factory — one load/save/remove
 * shape, parametrized per layer by a `buildQuery` + optional
 * `onAfterLoad` (for auxiliary aggregates like agentIds/logSessions) +
 * `readonly` (log). Layer 1 (focus) is a KV shape and stays bespoke.
 */

export type MemoryTab =
  | "focus"
  | "shared"
  | "context"
  | "archive"
  | "agent"
  | "log";

export type ListLayer = Exclude<MemoryTab, "focus">;

export interface FocusEntry {
  key: string;
  value: string;
}

export interface SharedRow {
  id: string;
  category: string;
  content: string;
  tags: string;
  source: string | null;
  created_at: number;
  updated_at: number;
}

export interface ContextRow {
  id: string;
  title: string;
  content: string;
  tags: string;
  derived_from: string;
  agent_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface ArchiveRow {
  id: string;
  title: string;
  content: string;
  tags: string;
  source_request_ids: string;
  confidence: "HIGH" | "LOW";
  agent_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface AgentMemRow {
  id: string;
  agent_id: string;
  content: string;
  tags: string;
  created_at: number;
  updated_at: number;
}

export interface LogRow {
  id: number;
  request_id: string;
  session_id: string;
  agent_id: string;
  role: string;
  content: string;
  token_count: number | null;
  created_at: number;
}

export type MemoryRow =
  | ({ __kind: "focus" } & FocusEntry)
  | ({ __kind: "shared" } & SharedRow)
  | ({ __kind: "context" } & ContextRow)
  | ({ __kind: "archive" } & ArchiveRow)
  | ({ __kind: "agent" } & AgentMemRow)
  | ({ __kind: "log" } & LogRow);

interface ListEnvelope<T> {
  items: T[];
  total: number;
}

/**
 * Schema map — field metadata per layer. Exposed for future generic editors;
 * current `MemoryEditor.vue` still uses per-kind template blocks, but new
 * forms should read from here.
 */
export const LAYER_SCHEMAS = {
  focus: { fields: ["key", "value"] as const, readonly: false, kind: "kv" as const },
  shared: { fields: ["category", "content", "tags"] as const, readonly: false, kind: "list" as const },
  context: { fields: ["title", "content", "tags"] as const, readonly: false, kind: "list" as const },
  archive: {
    fields: ["title", "content", "tags", "confidence"] as const,
    readonly: false,
    kind: "list" as const,
  },
  agent: { fields: ["content", "tags"] as const, readonly: false, kind: "list" as const },
  log: { fields: [] as const, readonly: true, kind: "list" as const },
} as const;

type ApiFn = ReturnType<typeof useApi>["api"];

function qs(params: Record<string, string | number | undefined>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === "" || v === null) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

interface LayerDeps {
  api: ApiFn;
  loading: Ref<boolean>;
  error: Ref<string | null>;
  selected: Ref<MemoryRow | null>;
}

interface LayerOpts {
  buildQuery: () => Record<string, string | number | undefined>;
  readonly?: boolean;
  onAfterLoad?: () => Promise<void>;
}

function useMemoryLayer<T extends { id: string | number }>(
  layer: ListLayer,
  deps: LayerDeps,
  opts: LayerOpts,
) {
  const state = useState<ListEnvelope<T>>(
    `memory-${layer}`,
    () => ({ items: [], total: 0 }),
  );

  async function load() {
    deps.loading.value = true;
    deps.error.value = null;
    try {
      state.value = await deps.api<ListEnvelope<T>>(
        `/v1/memory/${layer}${qs(opts.buildQuery())}`,
      );
      if (opts.onAfterLoad) await opts.onAfterLoad();
    } catch (e) {
      deps.error.value = (e as Error).message;
    } finally {
      deps.loading.value = false;
    }
  }

  async function save(id: T["id"], patch: Partial<T>): Promise<void> {
    if (opts.readonly) return;
    const updated = await deps.api<T>(`/v1/memory/${layer}/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    const s = deps.selected.value;
    if (
      s &&
      s.__kind === layer &&
      (s as unknown as { id: T["id"] }).id === id
    ) {
      deps.selected.value = {
        __kind: layer,
        ...(updated as object),
      } as MemoryRow;
    }
    await load();
  }

  async function remove(id: T["id"]): Promise<void> {
    if (opts.readonly) return;
    await deps.api(`/v1/memory/${layer}/${id}`, { method: "DELETE" });
    const s = deps.selected.value;
    if (
      s &&
      s.__kind === layer &&
      (s as unknown as { id: T["id"] }).id === id
    ) {
      deps.selected.value = null;
    }
    await load();
  }

  return { state, load, save, remove };
}

export function useMemory() {
  const { api } = useApi();

  const activeTab = useState<MemoryTab>("memory-tab", () => "shared");
  const search = useState<string>("memory-search", () => "");
  const page = useState<number>("memory-page", () => 1);
  const pageSize = useState<number>("memory-page-size", () => 50);

  const focus = useState<FocusEntry[]>("memory-focus", () => []);
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
  const stdQuery = () => ({
    limit: pageSize.value,
    offset: (page.value - 1) * pageSize.value,
    q: search.value || undefined,
  });

  const sharedL = useMemoryLayer<SharedRow>("shared", deps, {
    buildQuery: stdQuery,
  });
  const contextL = useMemoryLayer<ContextRow>("context", deps, {
    buildQuery: stdQuery,
  });
  const archiveL = useMemoryLayer<ArchiveRow>("archive", deps, {
    buildQuery: stdQuery,
  });
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
      logSessions.value = await api<string[]>(
        "/v1/memory/log/sessions?limit=50",
      );
    },
  });

  const totalForActive = computed(() => {
    switch (activeTab.value) {
      case "focus":
        return focus.value.length;
      case "shared":
        return sharedL.state.value.total;
      case "context":
        return contextL.state.value.total;
      case "archive":
        return archiveL.state.value.total;
      case "agent":
        return agentL.state.value.total;
      case "log":
        return logL.state.value.total;
    }
  });

  async function loadFocus() {
    loading.value = true;
    error.value = null;
    try {
      const data = await api<Record<string, string>>("/v1/memory/focus");
      focus.value = Object.entries(data).map(([key, value]) => ({
        key,
        value,
      }));
    } catch (e) {
      error.value = (e as Error).message;
    } finally {
      loading.value = false;
    }
  }

  async function loadActive() {
    switch (activeTab.value) {
      case "focus":
        return loadFocus();
      case "shared":
        return sharedL.load();
      case "context":
        return contextL.load();
      case "archive":
        return archiveL.load();
      case "agent":
        return agentL.load();
      case "log":
        return logL.load();
    }
  }

  function switchTab(tab: MemoryTab) {
    activeTab.value = tab;
    selected.value = null;
    search.value = "";
    page.value = 1;
    void loadActive();
  }

  function select(row: MemoryRow | null) {
    selected.value = row;
  }

  async function saveFocus(key: string, value: string) {
    await api(`/v1/memory/focus/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: JSON.stringify({ value }),
    });
    await loadFocus();
  }

  async function deleteFocus(key: string) {
    await api(`/v1/memory/focus/${encodeURIComponent(key)}`, {
      method: "DELETE",
    });
    if (selected.value?.__kind === "focus" && selected.value.key === key) {
      selected.value = null;
    }
    await loadFocus();
  }

  return {
    // state
    activeTab,
    search,
    page,
    pageSize,
    focus,
    shared: sharedL.state,
    context: contextL.state,
    archive: archiveL.state,
    agent: agentL.state,
    log: logL.state,
    agentIds,
    agentFilter,
    logSessions,
    logSessionFilter,
    selected,
    loading,
    error,
    totalForActive,
    // loaders
    loadFocus,
    loadShared: sharedL.load,
    loadContext: contextL.load,
    loadArchive: archiveL.load,
    loadAgent: agentL.load,
    loadLog: logL.load,
    loadActive,
    switchTab,
    select,
    // mutations
    saveFocus,
    deleteFocus,
    saveShared: sharedL.save,
    deleteShared: sharedL.remove,
    saveContext: contextL.save,
    deleteContext: contextL.remove,
    saveArchive: archiveL.save,
    deleteArchive: archiveL.remove,
    saveAgent: agentL.save,
    deleteAgent: agentL.remove,
  };
}
