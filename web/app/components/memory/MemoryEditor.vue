<script setup lang="ts">
import { toRef } from "vue";
import type { MemoryRow } from "~/composables/useMemory";

const props = defineProps<{ selected: MemoryRow }>();
const emit = defineEmits<{
  close: [];
  delete: [row: MemoryRow];
  "save-focus": [key: string, value: string];
  "save-shared": [
    id: string,
    patch: { category: string; content: string; tags: string },
  ];
  "save-context": [
    id: string,
    patch: { title: string; content: string; tags: string },
  ];
  // M-12 (mig 15): confidence unified to REAL [0..1] | null.
  "save-archive": [
    id: string,
    patch: {
      title: string;
      content: string;
      tags: string;
      confidence: number | null;
    },
  ];
  "save-agent": [id: string, patch: { content: string; tags: string }];
}>();

const {
  value,
  category,
  title,
  content,
  tags,
  confidence,
  dirty,
  markDirty,
  buildPatch,
  fmtTs,
  badgeColor,
  rowBadge,
} = useMemoryEditor(toRef(props, "selected"));

function handleSave() {
  if (!dirty.value) return;
  const p = buildPatch(props.selected);
  switch (p.kind) {
    case "focus":
      emit("save-focus", p.data.key, p.data.value);
      break;
    case "shared":
      emit("save-shared", p.data.id, p.data.patch);
      break;
    case "context":
      emit("save-context", p.data.id, p.data.patch);
      break;
    case "archive":
      emit("save-archive", p.data.id, p.data.patch);
      break;
    case "agent":
      emit("save-agent", p.data.id, p.data.patch);
      break;
    case "log":
      /* view-only */
      break;
  }
  dirty.value = false;
}
</script>

<template>
  <div
    class="w-96 min-w-80 border-l border-(--ui-border) overflow-y-auto p-4 space-y-3 bg-(--ui-bg-elevated)"
  >
    <MemoryEditorHeader
      :selected="selected"
      :badge-color="badgeColor(selected)"
      :row-badge="rowBadge(selected)"
      :format-ts="fmtTs"
      @close="emit('close')"
    />

    <MemoryEditorFocusBody
      v-if="selected.__kind === 'focus'"
      v-model:value="value"
      :row-key="selected.key"
      @change="markDirty"
    />

    <MemoryEditorSharedBody
      v-else-if="selected.__kind === 'shared'"
      v-model:category="category"
      v-model:content="content"
      v-model:tags="tags"
      @change="markDirty"
    />

    <MemoryEditorContextBody
      v-else-if="selected.__kind === 'context'"
      v-model:title="title"
      v-model:content="content"
      v-model:tags="tags"
      @change="markDirty"
    />

    <MemoryEditorArchiveBody
      v-else-if="selected.__kind === 'archive'"
      v-model:title="title"
      v-model:content="content"
      v-model:tags="tags"
      v-model:confidence="confidence"
      @change="markDirty"
    />

    <MemoryEditorAgentBody
      v-else-if="selected.__kind === 'agent'"
      v-model:content="content"
      v-model:tags="tags"
      :agent-id="selected.agent_id"
      @change="markDirty"
    />

    <MemoryEditorLogBody
      v-else-if="selected.__kind === 'log'"
      :row="selected"
      :format-ts="fmtTs"
    />

    <MemoryEditorFooter
      v-if="selected.__kind !== 'log'"
      :dirty="dirty"
      @save="handleSave"
      @delete="emit('delete', selected)"
    />
  </div>
</template>
