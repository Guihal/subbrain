import { reactive, ref, toRefs, watch, type Ref } from "vue";
import type { MemoryRow } from "../useMemory";
import {
  buildPatch as buildPatchPure,
  resetFrom as resetFromPure,
  type EditorFields,
} from "./patches";
import { badgeColor, fmtTs, rowBadge } from "./format";

export type {
  AgentPatch,
  ArchivePatch,
  ContextPatch,
  EditorPatch,
  FocusPatch,
  SharedPatch,
} from "./patches";

export function useMemoryEditor(selected: Ref<MemoryRow>) {
  // M-12 (mig 15): confidence unified to REAL [0..1] | null.
  const fields = reactive<EditorFields>({
    value: "",
    category: "",
    title: "",
    content: "",
    tags: "",
    confidence: null,
  });

  const dirty = ref(false);

  function resetFrom(row: MemoryRow) {
    resetFromPure(fields, row);
    dirty.value = false;
  }

  watch(selected, resetFrom, { immediate: true });

  function markDirty() {
    dirty.value = true;
  }

  function buildPatch(row: MemoryRow) {
    return buildPatchPure(fields, row);
  }

  return {
    ...toRefs(fields),
    dirty,
    markDirty,
    resetFrom,
    buildPatch,
    fmtTs,
    badgeColor,
    rowBadge,
  };
}
