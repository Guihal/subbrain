<script setup lang="ts">
import type { HistoryItem, TaskRow } from "~/types/task";

defineProps<{
  mode: "active" | "history";
  activeItems: TaskRow[];
  historyItems: HistoryItem[];
  loading: boolean;
}>();

const emit = defineEmits<{
  start: [task: TaskRow];
  done: [task: TaskRow];
  cancel: [task: TaskRow];
  edit: [task: TaskRow];
  delete: [task: TaskRow];
  "new-task": [];
}>();
</script>

<template>
  <table class="tasks-table">
    <thead>
      <tr>
        <th>Scope</th>
        <th>St</th>
        <th>Title</th>
        <th>Pri</th>
        <th>Due</th>
        <th>Updated</th>
        <th />
      </tr>
    </thead>
    <tbody v-if="mode === 'active'">
      <TaskRow
        v-for="task in activeItems"
        :key="task.id"
        :task="task"
        @start="emit('start', task)"
        @done="emit('done', task)"
        @cancel="emit('cancel', task)"
        @edit="emit('edit', task)"
        @delete="emit('delete', task)"
      />
      <tr v-if="!activeItems.length && !loading">
        <td colspan="7" class="empty">
          Нет задач. Создай через
          <button class="link" @click="emit('new-task')">+ Новая</button>.
        </td>
      </tr>
    </tbody>
    <tbody v-else>
      <template v-for="item in historyItems" :key="item.id">
        <TaskRow
          v-if="item.kind === 'task'"
          :task="item"
          @start="emit('start', item)"
          @done="emit('done', item)"
          @cancel="emit('cancel', item)"
          @edit="emit('edit', item)"
          @delete="emit('delete', item)"
        />
        <TaskHistoryDigest
          v-else
          :title="item.title"
          :content="item.content"
          :created-at="item.created_at"
        />
      </template>
      <tr v-if="!historyItems.length">
        <td colspan="7" class="empty">История пуста</td>
      </tr>
    </tbody>
  </table>
</template>

<style scoped>
.tasks-table {
  width: 100%;
  border-collapse: collapse;
}
.tasks-table th {
  text-align: left;
  font-size: 0.7rem;
  text-transform: uppercase;
  color: var(--ui-text-muted);
  padding: 0.4rem 0.6rem;
  border-bottom: 1px solid var(--ui-border);
}
.tasks-table .empty {
  text-align: center;
  color: var(--ui-text-muted);
  padding: 1.5rem;
}
.tasks-table .link {
  color: var(--ui-primary);
  text-decoration: underline;
  cursor: pointer;
}
</style>
