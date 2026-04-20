/**
 * Memory admin composable — backs the /memory page.
 *
 * State is shared across mounts via useState so switching tabs keeps
 * loaded lists (no refetch churn). All mutations go through api() which
 * injects the Bearer token via useApi().
 */

export type MemoryTab =
  | "focus"
  | "shared"
  | "context"
  | "archive"
  | "agent"
  | "log";

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

export function useMemory() {
  const { api } = useApi();

  const activeTab = useState<MemoryTab>("memory-tab", () => "shared");
  const search = useState<string>("memory-search", () => "");
  const page = useState<number>("memory-page", () => 1);
  const pageSize = useState<number>("memory-page-size", () => 50);

  const focus = useState<FocusEntry[]>("memory-focus", () => []);
  const shared = useState<{ items: SharedRow[]; total: number }>(
    "memory-shared",
    () => ({ items: [], total: 0 }),
  );
  const context = useState<{ items: ContextRow[]; total: number }>(
    "memory-context",
    () => ({ items: [], total: 0 }),
  );
  const archive = useState<{ items: ArchiveRow[]; total: number }>(
    "memory-archive",
    () => ({ items: [], total: 0 }),
  );
  const agent = useState<{ items: AgentMemRow[]; total: number }>(
    "memory-agent",
    () => ({ items: [], total: 0 }),
  );
  const agentIds = useState<string[]>("memory-agent-ids", () => []);
  const agentFilter = useState<string>("memory-agent-filter", () => "");
  const log = useState<{ items: LogRow[]; total: number }>(
    "memory-log",
    () => ({ items: [], total: 0 }),
  );
  const logSessions = useState<string[]>("memory-log-sessions", () => []);
  const logSessionFilter = useState<string>(
    "memory-log-session-filter",
    () => "",
  );

  const selected = useState<MemoryRow | null>("memory-selected", () => null);
  const loading = useState<boolean>("memory-loading", () => false);
  const error = useState<string | null>("memory-error", () => null);

  const totalForActive = computed(() => {
    switch (activeTab.value) {
      case "focus":
        return focus.value.length;
      case "shared":
        return shared.value.total;
      case "context":
        return context.value.total;
      case "archive":
        return archive.value.total;
      case "agent":
        return agent.value.total;
      case "log":
        return log.value.total;
    }
  });

  // ─── Loaders ─────────────────────────────────────────

  function qs(params: Record<string, string | number | undefined>): string {
    const parts: string[] = [];
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === "" || v === null) continue;
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    }
    return parts.length ? `?${parts.join("&")}` : "";
  }

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

  async function loadShared() {
    loading.value = true;
    error.value = null;
    try {
      shared.value = await api<ListEnvelope<SharedRow>>(
        `/v1/memory/shared${qs({
          limit: pageSize.value,
          offset: (page.value - 1) * pageSize.value,
          q: search.value || undefined,
        })}`,
      );
    } catch (e) {
      error.value = (e as Error).message;
    } finally {
      loading.value = false;
    }
  }

  async function loadContext() {
    loading.value = true;
    error.value = null;
    try {
      context.value = await api<ListEnvelope<ContextRow>>(
        `/v1/memory/context${qs({
          limit: pageSize.value,
          offset: (page.value - 1) * pageSize.value,
          q: search.value || undefined,
        })}`,
      );
    } catch (e) {
      error.value = (e as Error).message;
    } finally {
      loading.value = false;
    }
  }

  async function loadArchive() {
    loading.value = true;
    error.value = null;
    try {
      archive.value = await api<ListEnvelope<ArchiveRow>>(
        `/v1/memory/archive${qs({
          limit: pageSize.value,
          offset: (page.value - 1) * pageSize.value,
          q: search.value || undefined,
        })}`,
      );
    } catch (e) {
      error.value = (e as Error).message;
    } finally {
      loading.value = false;
    }
  }

  async function loadAgent() {
    loading.value = true;
    error.value = null;
    try {
      const [list, ids] = await Promise.all([
        api<ListEnvelope<AgentMemRow>>(
          `/v1/memory/agent${qs({
            limit: pageSize.value,
            offset: (page.value - 1) * pageSize.value,
            agent_id: agentFilter.value || undefined,
          })}`,
        ),
        api<string[]>("/v1/memory/agent/agents"),
      ]);
      agent.value = list;
      agentIds.value = ids;
    } catch (e) {
      error.value = (e as Error).message;
    } finally {
      loading.value = false;
    }
  }

  async function loadLog() {
    loading.value = true;
    error.value = null;
    try {
      const [list, sessions] = await Promise.all([
        api<ListEnvelope<LogRow>>(
          `/v1/memory/log${qs({
            limit: pageSize.value,
            offset: (page.value - 1) * pageSize.value,
            session_id: logSessionFilter.value || undefined,
          })}`,
        ),
        api<string[]>("/v1/memory/log/sessions?limit=50"),
      ]);
      log.value = list;
      logSessions.value = sessions;
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
        return loadShared();
      case "context":
        return loadContext();
      case "archive":
        return loadArchive();
      case "agent":
        return loadAgent();
      case "log":
        return loadLog();
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

  // ─── Mutations ───────────────────────────────────────

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

  async function saveShared(id: string, patch: Partial<SharedRow>) {
    const updated = await api<SharedRow>(`/v1/memory/shared/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    if (selected.value?.__kind === "shared" && selected.value.id === id) {
      selected.value = { __kind: "shared", ...updated };
    }
    await loadShared();
  }

  async function deleteShared(id: string) {
    await api(`/v1/memory/shared/${id}`, { method: "DELETE" });
    if (selected.value?.__kind === "shared" && selected.value.id === id) {
      selected.value = null;
    }
    await loadShared();
  }

  async function saveContext(id: string, patch: Partial<ContextRow>) {
    const updated = await api<ContextRow>(`/v1/memory/context/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    if (selected.value?.__kind === "context" && selected.value.id === id) {
      selected.value = { __kind: "context", ...updated };
    }
    await loadContext();
  }

  async function deleteContext(id: string) {
    await api(`/v1/memory/context/${id}`, { method: "DELETE" });
    if (selected.value?.__kind === "context" && selected.value.id === id) {
      selected.value = null;
    }
    await loadContext();
  }

  async function saveArchive(id: string, patch: Partial<ArchiveRow>) {
    const updated = await api<ArchiveRow>(`/v1/memory/archive/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    if (selected.value?.__kind === "archive" && selected.value.id === id) {
      selected.value = { __kind: "archive", ...updated };
    }
    await loadArchive();
  }

  async function deleteArchive(id: string) {
    await api(`/v1/memory/archive/${id}`, { method: "DELETE" });
    if (selected.value?.__kind === "archive" && selected.value.id === id) {
      selected.value = null;
    }
    await loadArchive();
  }

  async function saveAgent(id: string, patch: Partial<AgentMemRow>) {
    const updated = await api<AgentMemRow>(`/v1/memory/agent/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    if (selected.value?.__kind === "agent" && selected.value.id === id) {
      selected.value = { __kind: "agent", ...updated };
    }
    await loadAgent();
  }

  async function deleteAgent(id: string) {
    await api(`/v1/memory/agent/${id}`, { method: "DELETE" });
    if (selected.value?.__kind === "agent" && selected.value.id === id) {
      selected.value = null;
    }
    await loadAgent();
  }

  return {
    // state
    activeTab,
    search,
    page,
    pageSize,
    focus,
    shared,
    context,
    archive,
    agent,
    agentIds,
    agentFilter,
    log,
    logSessions,
    logSessionFilter,
    selected,
    loading,
    error,
    totalForActive,
    // loaders
    loadFocus,
    loadShared,
    loadContext,
    loadArchive,
    loadAgent,
    loadLog,
    loadActive,
    switchTab,
    select,
    // mutations
    saveFocus,
    deleteFocus,
    saveShared,
    deleteShared,
    saveContext,
    deleteContext,
    saveArchive,
    deleteArchive,
    saveAgent,
    deleteAgent,
  };
}
