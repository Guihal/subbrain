<script setup lang="ts">
import { ref } from "vue";
import { useMemory, type MemoryRow as Row, type EdgeInfo } from "~/composables/useMemory";

const props = defineProps<{
  row: Row;
  title: string;
  badge: string;
  badgeColor: string;
  ts?: number;
  preview?: string;
  selected?: boolean;
  deletable?: boolean;
  pending?: boolean;
}>();

const emit = defineEmits<{
  select: [];
  delete: [];
  approve: [];
  reject: [];
}>();

function fmt(ts: number): string {
  return new Date(ts * 1000).toLocaleString("ru-RU", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// M-14: lazy-loaded 1-hop edges. Cached per-row in local refs so re-expand
// doesn't refetch. Only meaningful for context|shared|archive (typed edges).
const edgesOpen = ref(false);
const edges = ref<EdgeInfo[] | null>(null);
const edgesLoading = ref(false);
const edgesError = ref<string | null>(null);
const edgeLayer = props.row.__kind;
const edgeId = (props.row as { id?: string | number }).id;
const supportsEdges =
  (edgeLayer === "context" || edgeLayer === "shared" || edgeLayer === "archive") &&
  typeof edgeId === "string" &&
  edgeId.length > 0;

async function toggleEdges(e: MouseEvent) {
  e.stopPropagation();
  edgesOpen.value = !edgesOpen.value;
  if (edgesOpen.value && edges.value === null && supportsEdges) {
    edgesLoading.value = true;
    edgesError.value = null;
    try {
      edges.value = await useMemory().fetchEdges(edgeId as string, edgeLayer);
    } catch (err) {
      edgesError.value = (err as Error).message;
      edges.value = [];
    } finally {
      edgesLoading.value = false;
    }
  }
}
</script>

<template>
  <div
    class="group px-3 py-2 cursor-pointer text-sm border-b border-(--ui-border)/30 transition-colors"
    :class="
      selected
        ? 'bg-(--ui-bg-accented) text-(--ui-text)'
        : 'text-(--ui-text-muted) hover:bg-(--ui-bg)/60 hover:text-(--ui-text)'
    "
    @click="emit('select')"
  >
    <div class="flex items-start gap-2">
      <span
        class="text-[10px] font-mono shrink-0 mt-0.5 min-w-14 truncate"
        :class="badgeColor"
        :title="badge"
      >
        {{ badge }}
      </span>
      <div class="flex-1 min-w-0">
        <div class="truncate">{{ title }}</div>
        <div
          v-if="preview"
          class="text-xs text-(--ui-text-dimmed) truncate mt-0.5"
        >
          {{ preview }}
        </div>
      </div>
      <span
        v-if="ts"
        class="text-[10px] text-(--ui-text-dimmed) shrink-0 mt-1"
      >
        {{ fmt(ts) }}
      </span>
      <button
        v-if="supportsEdges"
        class="opacity-60 group-hover:opacity-100 text-[10px] shrink-0 mt-0.5 px-1 rounded hover:bg-(--ui-bg)"
        :title="edgesOpen ? 'Hide edges' : 'Show edges'"
        @click="toggleEdges"
      >
        🔗 {{ edgesOpen ? '▾' : '▸' }}
      </button>
      <template v-if="pending">
        <button
          class="shrink-0 px-1.5 py-0.5 text-[11px] rounded border border-green-500/40 text-green-400 hover:bg-green-500/10"
          title="Approve"
          @click.stop="emit('approve')"
        >
          ✓ Approve
        </button>
        <button
          class="shrink-0 px-1.5 py-0.5 text-[11px] rounded border border-red-500/40 text-red-400 hover:bg-red-500/10"
          title="Reject"
          @click.stop="emit('reject')"
        >
          ✗ Reject
        </button>
      </template>
      <button
        v-if="deletable !== false && !pending"
        class="opacity-0 group-hover:opacity-100 text-(--ui-text-muted) hover:text-red-400 shrink-0 mt-0.5"
        title="Удалить"
        @click.stop="emit('delete')"
      >
        <UIcon name="i-lucide-x" class="size-3.5" />
      </button>
    </div>
    <div
      v-if="edgesOpen && supportsEdges"
      class="mt-1 ml-16 text-[11px] font-mono text-(--ui-text-dimmed)"
      @click.stop
    >
      <div v-if="edgesLoading">loading…</div>
      <div v-else-if="edgesError" class="text-red-400">{{ edgesError }}</div>
      <div v-else-if="edges && edges.length === 0">no edges</div>
      <ul v-else>
        <li
          v-for="(e, i) in edges"
          :key="i"
          :class="e.kind === 'contradicts' ? 'text-red-400' : ''"
        >
          → {{ e.kind }}: {{ e.id.slice(0, 8) }} [{{ e.layer }}, w={{ e.weight.toFixed(2) }}]
        </li>
      </ul>
    </div>
  </div>
</template>
