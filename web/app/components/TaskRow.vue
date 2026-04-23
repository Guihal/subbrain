<script setup lang="ts">
import type { TaskRow, TaskScope, TaskStatus } from "~/types/task";

const props = defineProps<{ task: TaskRow }>();
defineEmits<{
  start: [];
  done: [];
  cancel: [];
  edit: [];
  delete: [];
}>();

const SCOPE_COLORS: Record<TaskScope, string> = {
  global: "bg-gray-500/10 text-gray-400",
  autonomous: "bg-blue-500/10 text-blue-400",
  "free-agent": "bg-purple-500/10 text-purple-400",
  freelance: "bg-orange-500/10 text-orange-400",
  tg: "bg-teal-500/10 text-teal-400",
};

const STATUS_ICON: Record<TaskStatus, string> = {
  open: "⏳",
  in_progress: "📌",
  done: "✅",
  cancelled: "❌",
};

const priorityClass = computed(() => {
  const p = props.task.priority;
  if (p <= 0) return "";
  if (p <= 3) return "bg-gray-500/10 text-gray-400";
  if (p <= 7) return "bg-yellow-500/10 text-yellow-400";
  return "bg-red-500/10 text-red-400";
});

const mskDate = new Intl.DateTimeFormat("ru-RU", {
  timeZone: "Europe/Moscow",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const relTime = new Intl.RelativeTimeFormat("ru-RU", { numeric: "auto" });

function formatDue(ts: number | null): string {
  return ts === null ? "" : mskDate.format(ts * 1000);
}

function formatRel(ts: number): string {
  const diff = ts * 1000 - Date.now();
  const abs = Math.abs(diff);
  if (abs < 3600_000) return relTime.format(Math.round(diff / 60_000), "minute");
  if (abs < 86400_000) return relTime.format(Math.round(diff / 3600_000), "hour");
  return relTime.format(Math.round(diff / 86400_000), "day");
}

const isOverdue = computed(
  () =>
    props.task.due_at !== null &&
    props.task.due_at * 1000 < Date.now() &&
    props.task.status !== "done" &&
    props.task.status !== "cancelled",
);

const canAct = computed(
  () => props.task.status === "open" || props.task.status === "in_progress",
);
</script>

<template>
  <tr class="task-row" :class="{ overdue: isOverdue }">
    <td>
      <span
        class="px-1.5 py-0.5 rounded text-xs"
        :class="SCOPE_COLORS[task.scope]"
      >
        {{ task.scope }}
      </span>
    </td>
    <td class="text-lg">{{ STATUS_ICON[task.status] }}</td>
    <td class="task-title">
      <span :title="task.title">{{ task.title }}</span>
      <p
        v-if="task.description"
        class="text-xs text-(--ui-text-muted) truncate"
        :title="task.description"
      >
        {{ task.description }}
      </p>
    </td>
    <td>
      <span
        v-if="task.priority > 0"
        class="px-1.5 py-0.5 rounded text-xs"
        :class="priorityClass"
      >
        p{{ task.priority }}
      </span>
    </td>
    <td class="text-xs">{{ formatDue(task.due_at) }}</td>
    <td class="text-xs text-(--ui-text-muted)">
      {{ formatRel(task.updated_at) }}
    </td>
    <td class="task-actions">
      <UButton
        v-if="task.status === 'open'"
        icon="i-lucide-play"
        size="xs"
        variant="ghost"
        title="Начать"
        @click="$emit('start')"
      />
      <UButton
        v-if="canAct"
        icon="i-lucide-check"
        size="xs"
        variant="ghost"
        title="Завершить"
        @click="$emit('done')"
      />
      <UButton
        v-if="canAct"
        icon="i-lucide-x"
        size="xs"
        variant="ghost"
        title="Отменить"
        @click="$emit('cancel')"
      />
      <UButton
        icon="i-lucide-pencil"
        size="xs"
        variant="ghost"
        title="Редактировать"
        @click="$emit('edit')"
      />
      <UButton
        icon="i-lucide-trash-2"
        size="xs"
        variant="ghost"
        title="Удалить"
        @click="$emit('delete')"
      />
    </td>
  </tr>
</template>

<style scoped>
.task-row td {
  padding: 0.4rem 0.6rem;
  border-bottom: 1px solid var(--ui-border);
  font-size: 0.85rem;
  vertical-align: top;
}
.task-row.overdue {
  border-left: 4px solid rgb(239 68 68);
}
.task-title {
  max-width: 48ch;
}
.task-title span {
  display: block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.task-actions {
  display: flex;
  gap: 0.15rem;
  justify-content: flex-end;
  white-space: nowrap;
}
</style>
