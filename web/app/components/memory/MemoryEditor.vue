<script setup lang="ts">
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
  "save-archive": [
    id: string,
    patch: {
      title: string;
      content: string;
      tags: string;
      confidence: "HIGH" | "LOW";
    },
  ];
  "save-agent": [id: string, patch: { content: string; tags: string }];
}>();

const { render } = useMarkdown();

const form = ref<Record<string, string>>({});
const dirty = ref(false);

watch(
  () => props.selected,
  (row) => {
    dirty.value = false;
    if (!row) {
      form.value = {};
      return;
    }
    switch (row.__kind) {
      case "focus":
        form.value = { key: row.key, value: row.value };
        break;
      case "shared":
        form.value = {
          category: row.category,
          content: row.content,
          tags: row.tags,
        };
        break;
      case "context":
        form.value = {
          title: row.title,
          content: row.content,
          tags: row.tags,
        };
        break;
      case "archive":
        form.value = {
          title: row.title,
          content: row.content,
          tags: row.tags,
          confidence: row.confidence,
        };
        break;
      case "agent":
        form.value = { content: row.content, tags: row.tags };
        break;
      case "log":
        form.value = {};
        break;
    }
  },
  { immediate: true },
);

function onFieldChange() {
  dirty.value = true;
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

async function handleSave() {
  if (!dirty.value) return;
  const row = props.selected;
  switch (row.__kind) {
    case "focus":
      emit("save-focus", row.key, form.value.value ?? "");
      break;
    case "shared":
      emit("save-shared", row.id, {
        category: form.value.category ?? "",
        content: form.value.content ?? "",
        tags: form.value.tags ?? "",
      });
      break;
    case "context":
      emit("save-context", row.id, {
        title: form.value.title ?? "",
        content: form.value.content ?? "",
        tags: form.value.tags ?? "",
      });
      break;
    case "archive":
      emit("save-archive", row.id, {
        title: form.value.title ?? "",
        content: form.value.content ?? "",
        tags: form.value.tags ?? "",
        confidence: (form.value.confidence ?? "LOW") as "HIGH" | "LOW",
      });
      break;
    case "agent":
      emit("save-agent", row.id, {
        content: form.value.content ?? "",
        tags: form.value.tags ?? "",
      });
      break;
  }
  dirty.value = false;
}
</script>

<template>
  <div
    class="w-96 min-w-80 border-l border-(--ui-border) overflow-y-auto p-4 space-y-3 bg-(--ui-bg-elevated)"
  >
    <div class="flex items-center gap-2">
      <span :class="badgeColor(selected)" class="text-xs font-mono">
        {{ rowBadge(selected) }}
      </span>
      <span
        v-if="selected.__kind !== 'focus' && selected.__kind !== 'log'"
        class="text-xs text-(--ui-text-dimmed) ml-auto"
      >
        {{ fmtTs((selected as { updated_at: number }).updated_at) }}
      </span>
      <button
        class="text-(--ui-text-muted) hover:text-(--ui-text)"
        title="Закрыть"
        @click="emit('close')"
      >
        <UIcon name="i-lucide-x" class="size-4" />
      </button>
    </div>

    <template v-if="selected.__kind === 'focus'">
      <label class="text-xs text-(--ui-text-muted)">Ключ</label>
      <UInput :model-value="form.key" disabled size="sm" />
      <label class="text-xs text-(--ui-text-muted)">Значение</label>
      <UTextarea
        v-model="form.value"
        :rows="4"
        size="sm"
        @update:model-value="onFieldChange"
      />
    </template>

    <template v-else-if="selected.__kind === 'shared'">
      <label class="text-xs text-(--ui-text-muted)">Категория</label>
      <UInput
        v-model="form.category"
        size="sm"
        @update:model-value="onFieldChange"
      />
      <label class="text-xs text-(--ui-text-muted)">Контент</label>
      <UTextarea
        v-model="form.content"
        :rows="6"
        size="sm"
        @update:model-value="onFieldChange"
      />
      <label class="text-xs text-(--ui-text-muted)">Теги</label>
      <UInput
        v-model="form.tags"
        size="sm"
        @update:model-value="onFieldChange"
      />
    </template>

    <template
      v-else-if="selected.__kind === 'context' || selected.__kind === 'archive'"
    >
      <label class="text-xs text-(--ui-text-muted)">Заголовок</label>
      <UInput
        v-model="form.title"
        size="sm"
        @update:model-value="onFieldChange"
      />
      <label class="text-xs text-(--ui-text-muted)">Контент</label>
      <UTextarea
        v-model="form.content"
        :rows="10"
        size="sm"
        @update:model-value="onFieldChange"
      />
      <label class="text-xs text-(--ui-text-muted)">Теги</label>
      <UInput
        v-model="form.tags"
        size="sm"
        @update:model-value="onFieldChange"
      />
      <template v-if="selected.__kind === 'archive'">
        <label class="text-xs text-(--ui-text-muted)">Уверенность</label>
        <select
          v-model="form.confidence"
          class="w-full text-sm rounded border border-(--ui-border) bg-(--ui-bg) px-2 py-1"
          @change="onFieldChange"
        >
          <option value="HIGH">HIGH</option>
          <option value="LOW">LOW</option>
        </select>
      </template>
    </template>

    <template v-else-if="selected.__kind === 'agent'">
      <label class="text-xs text-(--ui-text-muted)">Agent</label>
      <UInput :model-value="selected.agent_id" disabled size="sm" />
      <label class="text-xs text-(--ui-text-muted)">Контент</label>
      <UTextarea
        v-model="form.content"
        :rows="8"
        size="sm"
        @update:model-value="onFieldChange"
      />
      <label class="text-xs text-(--ui-text-muted)">Теги</label>
      <UInput
        v-model="form.tags"
        size="sm"
        @update:model-value="onFieldChange"
      />
    </template>

    <template v-else-if="selected.__kind === 'log'">
      <div class="text-xs text-(--ui-text-muted) space-y-1">
        <div>session: <span class="font-mono">{{ selected.session_id }}</span></div>
        <div>request: <span class="font-mono">{{ selected.request_id }}</span></div>
        <div>role: {{ selected.role }}</div>
        <div>agent: {{ selected.agent_id }}</div>
        <div>tokens: {{ selected.token_count ?? "—" }}</div>
        <div>ts: {{ fmtTs(selected.created_at) }}</div>
      </div>
      <div
        class="text-xs leading-relaxed whitespace-pre-wrap p-2 bg-(--ui-bg) rounded border border-(--ui-border) max-h-96 overflow-auto"
        v-html="render(selected.content)"
      />
    </template>

    <div
      v-if="selected.__kind !== 'log'"
      class="flex items-center gap-2 pt-2 border-t border-(--ui-border)"
    >
      <UButton
        size="sm"
        :disabled="!dirty"
        icon="i-lucide-save"
        label="Сохранить"
        @click="handleSave"
      />
      <UButton
        size="sm"
        variant="ghost"
        color="error"
        icon="i-lucide-trash-2"
        label="Удалить"
        class="ml-auto"
        @click="emit('delete', selected)"
      />
    </div>
  </div>
</template>
