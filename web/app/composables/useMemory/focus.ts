import type { Ref } from "vue";
import type { FocusEntry, MemoryRow } from "./types";

type ApiFn = ReturnType<typeof useApi>["api"];

export interface FocusDeps {
  api: ApiFn;
  loading: Ref<boolean>;
  error: Ref<string | null>;
  selected: Ref<MemoryRow | null>;
}

export function useMemoryFocus(deps: FocusDeps) {
  const focus = useState<FocusEntry[]>("memory-focus", () => []);

  async function loadFocus() {
    deps.loading.value = true;
    deps.error.value = null;
    try {
      const data = await deps.api<Record<string, string>>("/v1/memory/focus");
      focus.value = Object.entries(data).map(([key, value]) => ({ key, value }));
    } catch (e) {
      deps.error.value = (e as Error).message;
    } finally {
      deps.loading.value = false;
    }
  }

  async function saveFocus(key: string, value: string) {
    await deps.api(`/v1/memory/focus/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: JSON.stringify({ value }),
    });
    await loadFocus();
  }

  async function deleteFocus(key: string) {
    await deps.api(`/v1/memory/focus/${encodeURIComponent(key)}`, {
      method: "DELETE",
    });
    if (deps.selected.value?.__kind === "focus" && deps.selected.value.key === key) {
      deps.selected.value = null;
    }
    await loadFocus();
  }

  return { focus, loadFocus, saveFocus, deleteFocus };
}
