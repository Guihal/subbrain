/**
 * Freelance leads composable — backs /freelance page.
 * Follows useMemory.ts shape: useState-shared, api() for mutations.
 */

export type FreelanceStatus = "new" | "taken" | "rejected";

export interface FreelanceLead {
  id: string;
  url: string;
  source: string;
  title: string;
  budget: number | null;
  score: number | null;
  reason: string | null;
  status: FreelanceStatus;
  created_at: number;
  updated_at: number;
}

interface ListEnvelope<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
}

export interface ScoutStatus {
  running: boolean;
  pausedUntil: Array<[string, number]>;
  lastRunAt: number | null;
  lastLeadAt: number | null;
  leadsToday: number;
}

const PAGE_SIZE = 20;

export function useFreelance() {
  const { api } = useApi();

  const items = useState<FreelanceLead[]>("fl.items", () => []);
  const total = useState<number>("fl.total", () => 0);
  const page = useState<number>("fl.page", () => 1);
  const statusFilter = useState<FreelanceStatus | "all">(
    "fl.statusFilter",
    () => "new",
  );
  const status = useState<ScoutStatus | null>("fl.status", () => null);
  const loading = useState<boolean>("fl.loading", () => false);

  async function refresh(): Promise<void> {
    loading.value = true;
    try {
      const params = new URLSearchParams({
        page: String(page.value),
        page_size: String(PAGE_SIZE),
      });
      if (statusFilter.value !== "all") {
        params.set("status", statusFilter.value);
      }
      const env = await api<ListEnvelope<FreelanceLead>>(
        `/v1/search/freelance/leads?${params.toString()}`,
      );
      items.value = env.items;
      total.value = env.total;
    } finally {
      loading.value = false;
    }
  }

  async function loadStatus(): Promise<void> {
    status.value = await api<ScoutStatus>(`/v1/search/freelance/status`);
  }

  async function mark(id: string, newStatus: FreelanceStatus): Promise<void> {
    await api(`/v1/search/freelance/leads/${id}`, {
      method: "PATCH",
      body: { status: newStatus },
    });
    await refresh();
  }

  async function start(): Promise<void> {
    await api(`/v1/search/freelance/start`, { method: "POST" });
    await loadStatus();
  }

  async function stop(): Promise<void> {
    await api(`/v1/search/freelance/stop`, { method: "POST" });
    await loadStatus();
  }

  function setStatusFilter(s: FreelanceStatus | "all") {
    statusFilter.value = s;
    page.value = 1;
    void refresh();
  }

  function setPage(p: number) {
    page.value = Math.max(1, p);
    void refresh();
  }

  return {
    items,
    total,
    page,
    statusFilter,
    status,
    loading,
    pageSize: PAGE_SIZE,
    refresh,
    loadStatus,
    mark,
    start,
    stop,
    setStatusFilter,
    setPage,
  };
}
