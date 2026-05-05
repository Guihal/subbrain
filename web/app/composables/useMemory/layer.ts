import type { Ref } from "vue";
import type { ListEnvelope, ListLayer, MemoryRow } from "./types";

type ApiFn = ReturnType<typeof useApi>["api"];

export interface LayerDeps {
  api: ApiFn;
  loading: Ref<boolean>;
  error: Ref<string | null>;
  selected: Ref<MemoryRow | null>;
}

export interface LayerOpts {
  buildQuery: () => Record<string, string | number | undefined>;
  readonly?: boolean;
  onAfterLoad?: () => Promise<void>;
}

function qs(params: Record<string, string | number | undefined>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === "" || v === null) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

export function useMemoryLayer<T extends { id: string | number }>(
  layer: ListLayer,
  deps: LayerDeps,
  opts: LayerOpts,
) {
  const state = useState<ListEnvelope<T>>(`memory-${layer}`, () => ({ items: [], total: 0 }));

  async function load() {
    deps.loading.value = true;
    deps.error.value = null;
    try {
      state.value = await deps.api<ListEnvelope<T>>(`/v1/memory/${layer}${qs(opts.buildQuery())}`);
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
    if (s && s.__kind === layer && (s as unknown as { id: T["id"] }).id === id) {
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
    if (s && s.__kind === layer && (s as unknown as { id: T["id"] }).id === id) {
      deps.selected.value = null;
    }
    await load();
  }

  return { state, load, save, remove };
}
