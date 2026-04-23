<script setup lang="ts">
import type { LogRow } from "~/composables/useMemory";

defineProps<{ row: LogRow; formatTs: (ts: number) => string }>();

const { render } = useMarkdown();
</script>

<template>
  <div class="text-xs text-(--ui-text-muted) space-y-1">
    <div>
      session: <span class="font-mono">{{ row.session_id }}</span>
    </div>
    <div>
      request: <span class="font-mono">{{ row.request_id }}</span>
    </div>
    <div>role: {{ row.role }}</div>
    <div>agent: {{ row.agent_id }}</div>
    <div>tokens: {{ row.token_count ?? "—" }}</div>
    <div>ts: {{ formatTs(row.created_at) }}</div>
  </div>
  <div
    class="text-xs leading-relaxed whitespace-pre-wrap p-2 bg-(--ui-bg) rounded border border-(--ui-border) max-h-96 overflow-auto"
    v-html="render(row.content)"
  />
</template>
