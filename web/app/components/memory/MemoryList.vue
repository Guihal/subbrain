<script setup lang="ts">
import type {
  AgentMemRow,
  ArchiveRow,
  ContextRow,
  FocusEntry,
  LogRow,
  MemoryRow,
  MemoryTab,
  SharedRow,
} from "~/composables/useMemory";

const props = defineProps<{
  active: MemoryTab;
  selected: MemoryRow | null;
  focus: FocusEntry[];
  shared: { items: SharedRow[]; total: number };
  context: { items: ContextRow[]; total: number };
  archive: { items: ArchiveRow[]; total: number };
  agent: { items: AgentMemRow[]; total: number };
  log: { items: LogRow[]; total: number };
  total: number;
  loading: boolean;
}>();

const emit = defineEmits<{
  select: [row: MemoryRow];
  delete: [row: MemoryRow];
}>();

function rowTitle(row: MemoryRow): string {
  switch (row.__kind) {
    case "focus":
      return row.key;
    case "shared":
      return row.content.slice(0, 80);
    case "context":
    case "archive":
      return row.title || row.content.slice(0, 80);
    case "agent":
      return row.content.slice(0, 80);
    case "log":
      return `[${row.role}] ${row.content.slice(0, 80)}`;
  }
}

// M-12 (mig 15): archive confidence is REAL [0..1] | null. Badge shows
// `.toFixed(2)` (or "—" for null); colour green ≥ 0.8, gray otherwise.
function rowBadge(row: MemoryRow): string {
  switch (row.__kind) {
    case "focus":
      return "key";
    case "shared":
      return row.category || "?";
    case "context":
      return (row.agent_id || "auto").slice(0, 12);
    case "archive":
      return row.confidence === null ? "—" : row.confidence.toFixed(2);
    case "agent":
      return row.agent_id;
    case "log":
      return row.agent_id || row.role;
  }
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
      return row.confidence !== null && row.confidence >= 0.8 ? "text-green-400" : "text-gray-400";
    case "agent":
      return "text-orange-400";
    case "log":
      return "text-sky-400";
  }
}

function isSelected(row: MemoryRow): boolean {
  const s = props.selected;
  if (!s || s.__kind !== row.__kind) return false;
  if (s.__kind === "focus" && row.__kind === "focus") return s.key === row.key;
  return (s as { id: string | number }).id === (row as { id: string | number }).id;
}
</script>

<template>
  <div class="flex-1 overflow-y-auto">
    <template v-if="active === 'focus'">
      <MemoryRow
        v-for="entry in focus"
        :key="entry.key"
        :row="{ __kind: 'focus', ...entry }"
        :selected="isSelected({ __kind: 'focus', ...entry })"
        :title="rowTitle({ __kind: 'focus', ...entry })"
        badge="key"
        badge-color="text-yellow-400"
        :preview="entry.value"
        @select="emit('select', { __kind: 'focus', ...entry })"
        @delete="emit('delete', { __kind: 'focus', ...entry })"
      />
    </template>

    <template v-else-if="active === 'shared'">
      <MemoryRow
        v-for="row in shared.items"
        :key="row.id"
        :row="{ __kind: 'shared', ...row }"
        :selected="isSelected({ __kind: 'shared', ...row })"
        :title="rowTitle({ __kind: 'shared', ...row })"
        :badge="rowBadge({ __kind: 'shared', ...row })"
        :badge-color="badgeColor({ __kind: 'shared', ...row })"
        :ts="row.updated_at"
        @select="emit('select', { __kind: 'shared', ...row })"
        @delete="emit('delete', { __kind: 'shared', ...row })"
      />
    </template>

    <template v-else-if="active === 'context'">
      <MemoryRow
        v-for="row in context.items"
        :key="row.id"
        :row="{ __kind: 'context', ...row }"
        :selected="isSelected({ __kind: 'context', ...row })"
        :title="rowTitle({ __kind: 'context', ...row })"
        :badge="rowBadge({ __kind: 'context', ...row })"
        :badge-color="badgeColor({ __kind: 'context', ...row })"
        :ts="row.updated_at"
        @select="emit('select', { __kind: 'context', ...row })"
        @delete="emit('delete', { __kind: 'context', ...row })"
      />
    </template>

    <template v-else-if="active === 'archive'">
      <MemoryRow
        v-for="row in archive.items"
        :key="row.id"
        :row="{ __kind: 'archive', ...row }"
        :selected="isSelected({ __kind: 'archive', ...row })"
        :title="rowTitle({ __kind: 'archive', ...row })"
        :badge="rowBadge({ __kind: 'archive', ...row })"
        :badge-color="badgeColor({ __kind: 'archive', ...row })"
        :ts="row.updated_at"
        @select="emit('select', { __kind: 'archive', ...row })"
        @delete="emit('delete', { __kind: 'archive', ...row })"
      />
    </template>

    <template v-else-if="active === 'agent'">
      <MemoryRow
        v-for="row in agent.items"
        :key="row.id"
        :row="{ __kind: 'agent', ...row }"
        :selected="isSelected({ __kind: 'agent', ...row })"
        :title="rowTitle({ __kind: 'agent', ...row })"
        :badge="rowBadge({ __kind: 'agent', ...row })"
        :badge-color="badgeColor({ __kind: 'agent', ...row })"
        :ts="row.updated_at"
        @select="emit('select', { __kind: 'agent', ...row })"
        @delete="emit('delete', { __kind: 'agent', ...row })"
      />
    </template>

    <template v-else-if="active === 'log'">
      <MemoryRow
        v-for="row in log.items"
        :key="row.id"
        :row="{ __kind: 'log', ...row }"
        :selected="isSelected({ __kind: 'log', ...row })"
        :title="rowTitle({ __kind: 'log', ...row })"
        :badge="rowBadge({ __kind: 'log', ...row })"
        :badge-color="badgeColor({ __kind: 'log', ...row })"
        :ts="row.created_at"
        :deletable="false"
        @select="emit('select', { __kind: 'log', ...row })"
      />
    </template>

    <div
      v-if="total === 0 && !loading"
      class="text-center text-(--ui-text-dimmed) text-sm py-10"
    >
      Пусто
    </div>
  </div>
</template>
