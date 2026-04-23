import { reactive, ref, toRefs, watch, type Ref } from "vue";
import type { MemoryRow } from "./useMemory";

export type FocusPatch = { key: string; value: string };
export type SharedPatch = {
  id: string;
  patch: { category: string; content: string; tags: string };
};
export type ContextPatch = {
  id: string;
  patch: { title: string; content: string; tags: string };
};
export type ArchivePatch = {
  id: string;
  patch: {
    title: string;
    content: string;
    tags: string;
    confidence: "HIGH" | "LOW";
  };
};
export type AgentPatch = { id: string; patch: { content: string; tags: string } };

export type EditorPatch =
  | { kind: "focus"; data: FocusPatch }
  | { kind: "shared"; data: SharedPatch }
  | { kind: "context"; data: ContextPatch }
  | { kind: "archive"; data: ArchivePatch }
  | { kind: "agent"; data: AgentPatch }
  | { kind: "log" };

export function useMemoryEditor(selected: Ref<MemoryRow>) {
  const fields = reactive({
    value: "",
    category: "",
    title: "",
    content: "",
    tags: "",
    confidence: "LOW" as "HIGH" | "LOW",
  });

  const dirty = ref(false);

  function resetFrom(row: MemoryRow) {
    fields.value = "";
    fields.category = "";
    fields.title = "";
    fields.content = "";
    fields.tags = "";
    fields.confidence = "LOW";
    switch (row.__kind) {
      case "focus":
        fields.value = row.value;
        break;
      case "shared":
        fields.category = row.category;
        fields.content = row.content;
        fields.tags = row.tags;
        break;
      case "context":
        fields.title = row.title;
        fields.content = row.content;
        fields.tags = row.tags;
        break;
      case "archive":
        fields.title = row.title;
        fields.content = row.content;
        fields.tags = row.tags;
        fields.confidence = row.confidence;
        break;
      case "agent":
        fields.content = row.content;
        fields.tags = row.tags;
        break;
      case "log":
        /* view-only */
        break;
    }
    dirty.value = false;
  }

  watch(selected, resetFrom, { immediate: true });

  function markDirty() {
    dirty.value = true;
  }

  function buildPatch(row: MemoryRow): EditorPatch {
    switch (row.__kind) {
      case "focus":
        return { kind: "focus", data: { key: row.key, value: fields.value } };
      case "shared":
        return {
          kind: "shared",
          data: {
            id: row.id,
            patch: {
              category: fields.category,
              content: fields.content,
              tags: fields.tags,
            },
          },
        };
      case "context":
        return {
          kind: "context",
          data: {
            id: row.id,
            patch: {
              title: fields.title,
              content: fields.content,
              tags: fields.tags,
            },
          },
        };
      case "archive":
        return {
          kind: "archive",
          data: {
            id: row.id,
            patch: {
              title: fields.title,
              content: fields.content,
              tags: fields.tags,
              confidence: fields.confidence,
            },
          },
        };
      case "agent":
        return {
          kind: "agent",
          data: {
            id: row.id,
            patch: { content: fields.content, tags: fields.tags },
          },
        };
      case "log":
        return { kind: "log" };
    }
  }

  function fmtTs(ts: number): string {
    return new Date(ts * 1000).toLocaleString("ru-RU", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function badgeColor(row: MemoryRow): string {
    switch (row.__kind) {
      case "focus":
        return "text-yellow-400";
      case "shared":
        return "text-blue-400";
      case "context":
        return "text-purple-400";
      case "archive":
        return row.confidence === "HIGH" ? "text-green-400" : "text-gray-400";
      case "agent":
        return "text-orange-400";
      case "log":
        return "text-sky-400";
    }
  }

  function rowBadge(row: MemoryRow): string {
    switch (row.__kind) {
      case "focus":
        return "key";
      case "shared":
        return row.category || "?";
      case "context":
        return (row.agent_id || "auto").slice(0, 12);
      case "archive":
        return row.confidence;
      case "agent":
        return row.agent_id;
      case "log":
        return row.agent_id || row.role;
    }
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
