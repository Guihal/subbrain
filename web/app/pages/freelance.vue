<script setup lang="ts">
import type { FreelanceStatus } from "../composables/useFreelance";

const {
  items,
  total,
  page,
  pageSize,
  statusFilter,
  status,
  loading,
  refresh,
  loadStatus,
  mark,
  start,
  stop,
  setStatusFilter,
  setPage,
} = useFreelance();

const sidebarOpen = useState("sidebar-open", () => false);

const tabs: Array<FreelanceStatus | "all"> = [
  "new",
  "taken",
  "rejected",
  "all",
];

function tabLabel(s: FreelanceStatus | "all"): string {
  const map: Record<string, string> = {
    new: "Новые",
    taken: "Взято",
    rejected: "Отказ",
    all: "Все",
  };
  return map[s] ?? s;
}

function formatTime(ts: number): string {
  return new Date(ts * 1000).toLocaleString();
}

onMounted(async () => {
  await Promise.all([refresh(), loadStatus()]);
});
</script>

<template>
  <div class="flex-1 flex flex-col min-w-0 overflow-hidden">
    <header
      class="h-12 border-b border-(--ui-border) flex items-center gap-2 px-4 shrink-0"
    >
      <UButton
        icon="i-lucide-menu"
        variant="ghost"
        size="sm"
        class="md:hidden"
        @click="sidebarOpen = !sidebarOpen"
      />
      <span class="text-lg">💼 Фриланс</span>
      <div class="ml-auto flex items-center gap-2 text-xs text-(--ui-text-muted)">
        <span v-if="status">
          {{ status.running ? "▶️ running" : "⏸ stopped" }}
          · сегодня: {{ status.leadsToday }}
        </span>
        <UButton size="xs" variant="ghost" @click="start">Start</UButton>
        <UButton size="xs" variant="ghost" @click="stop">Stop</UButton>
      </div>
    </header>

    <nav class="fl-tabs flex gap-2 px-4 py-2 border-b border-(--ui-border) text-xs">
      <button
        v-for="s in tabs"
        :key="s"
        class="px-2 py-1 rounded"
        :class="statusFilter === s
          ? 'bg-(--ui-bg-accented) text-(--ui-text)'
          : 'text-(--ui-text-muted) hover:text-(--ui-text)'"
        @click="setStatusFilter(s)"
      >
        {{ tabLabel(s) }}
      </button>
    </nav>

    <div class="flex-1 overflow-auto">
      <table class="fl-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Source</th>
            <th>Budget</th>
            <th>Score</th>
            <th>Title</th>
            <th />
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in items" :key="row.id">
            <td>{{ formatTime(row.created_at) }}</td>
            <td>{{ row.source }}</td>
            <td>{{ row.budget ?? "?" }}</td>
            <td>{{ row.score ?? "?" }}/10</td>
            <td>{{ row.title }}</td>
            <td>
              <a :href="row.url" target="_blank" rel="noopener">открыть</a>
              <button @click="mark(row.id, 'taken')">взял</button>
              <button @click="mark(row.id, 'rejected')">не беру</button>
            </td>
          </tr>
          <tr v-if="!items.length && !loading">
            <td colspan="6" class="fl-empty">Нет лидов</td>
          </tr>
        </tbody>
      </table>
    </div>

    <footer class="fl-pager flex items-center gap-2 px-4 py-2 border-t border-(--ui-border) text-xs">
      <button :disabled="page <= 1" @click="setPage(page - 1)">←</button>
      <span>Стр. {{ page }} / {{ Math.max(1, Math.ceil(total / pageSize)) }}</span>
      <button
        :disabled="page >= Math.ceil(total / pageSize)"
        @click="setPage(page + 1)"
      >
        →
      </button>
    </footer>
  </div>
</template>

<style scoped>
.fl-table {
  width: 100%;
  border-collapse: collapse;
}
.fl-table th,
.fl-table td {
  padding: 0.4rem 0.6rem;
  border-bottom: 1px solid var(--ui-border);
  text-align: left;
  font-size: 0.85rem;
}
.fl-table a,
.fl-table button {
  margin-right: 0.4rem;
}
.fl-empty {
  text-align: center;
  color: var(--ui-text-muted);
}
</style>
