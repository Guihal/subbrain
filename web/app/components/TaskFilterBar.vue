<script setup lang="ts">
import type { StatusFilter, TaskScope } from "~/types/task";
import { TASK_SCOPES } from "~/types/task";

defineProps<{
  scope?: TaskScope;
  status: StatusFilter;
  mode: "active" | "history";
}>();
const emit = defineEmits<{
  "toggle-scope": [value: TaskScope];
  "set-status": [value: StatusFilter];
  "switch-mode": [value: "active" | "history"];
}>();

const STATUS_FILTERS: Array<{ key: StatusFilter; label: string }> = [
  { key: "active", label: "Активные" },
  { key: "open", label: "Open" },
  { key: "in_progress", label: "InProgress" },
  { key: "done", label: "Done" },
  { key: "cancelled", label: "Cancelled" },
  { key: "all", label: "Все" },
];
</script>

<template>
  <div>
    <nav
      class="flex flex-wrap gap-2 px-4 py-2 border-b border-(--ui-border) text-xs items-center"
    >
      <span class="text-(--ui-text-muted)">Scope:</span>
      <button
        v-for="s in TASK_SCOPES"
        :key="s"
        class="px-2 py-1 rounded"
        :class="
          scope === s
            ? 'bg-(--ui-bg-accented) text-(--ui-text)'
            : 'text-(--ui-text-muted) hover:text-(--ui-text)'
        "
        @click="emit('toggle-scope', s)"
      >
        {{ s }}
      </button>
      <span class="ml-4 text-(--ui-text-muted)">Status:</span>
      <button
        v-for="sf in STATUS_FILTERS"
        :key="sf.key"
        class="px-2 py-1 rounded"
        :class="
          status === sf.key
            ? 'bg-(--ui-bg-accented) text-(--ui-text)'
            : 'text-(--ui-text-muted) hover:text-(--ui-text)'
        "
        @click="emit('set-status', sf.key)"
      >
        {{ sf.label }}
      </button>
    </nav>

    <nav class="flex gap-2 px-4 py-2 border-b border-(--ui-border) text-xs">
      <button
        class="px-2 py-1 rounded"
        :class="
          mode === 'active'
            ? 'bg-(--ui-bg-accented) text-(--ui-text)'
            : 'text-(--ui-text-muted) hover:text-(--ui-text)'
        "
        @click="emit('switch-mode', 'active')"
      >
        Активные
      </button>
      <button
        class="px-2 py-1 rounded"
        :class="
          mode === 'history'
            ? 'bg-(--ui-bg-accented) text-(--ui-text)'
            : 'text-(--ui-text-muted) hover:text-(--ui-text)'
        "
        @click="emit('switch-mode', 'history')"
      >
        История
      </button>
    </nav>
  </div>
</template>
