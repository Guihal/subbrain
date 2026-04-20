<script setup lang="ts">
import type { MemoryRow, MemoryTab } from "~/composables/useMemory";

const memory = useMemory();
const {
  activeTab,
  search,
  page,
  pageSize,
  focus,
  shared,
  context,
  archive,
  agent,
  agentIds,
  agentFilter,
  log,
  logSessions,
  logSessionFilter,
  selected,
  loading,
  error,
  totalForActive,
  loadActive,
  switchTab,
  select,
  saveFocus,
  deleteFocus,
  saveShared,
  deleteShared,
  saveContext,
  deleteContext,
  saveArchive,
  deleteArchive,
  saveAgent,
  deleteAgent,
} = memory;

const { render } = useMarkdown();

const sidebarOpen = ref(false);

// Edit form state (mirrors selected row; dirty flag turns on Save)
const form = ref<Record<string, string>>({});
const dirty = ref(false);

watch(selected, (row) => {
  dirty.value = false;
  if (!row) {
    form.value = {};
    return;
  }
  // Flatten fields that can be edited per kind
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
    case "archive":
      form.value = {
        title: row.title,
        content: row.content,
        tags: row.tags,
        ...(row.__kind === "archive" ? { confidence: row.confidence } : {}),
      };
      break;
    case "agent":
      form.value = { content: row.content, tags: row.tags };
      break;
    case "log":
      form.value = {};
      break;
  }
});

function onFieldChange() {
  dirty.value = true;
}

async function handleSave() {
  if (!selected.value || !dirty.value) return;
  const row = selected.value;
  switch (row.__kind) {
    case "focus":
      await saveFocus(row.key, form.value.value ?? "");
      break;
    case "shared":
      await saveShared(row.id, {
        category: form.value.category,
        content: form.value.content,
        tags: form.value.tags,
      });
      break;
    case "context":
      await saveContext(row.id, {
        title: form.value.title,
        content: form.value.content,
        tags: form.value.tags,
      });
      break;
    case "archive":
      await saveArchive(row.id, {
        title: form.value.title,
        content: form.value.content,
        tags: form.value.tags,
        confidence: form.value.confidence as "HIGH" | "LOW",
      });
      break;
    case "agent":
      await saveAgent(row.id, {
        content: form.value.content,
        tags: form.value.tags,
      });
      break;
  }
  dirty.value = false;
}

const confirmDelete = ref<MemoryRow | null>(null);
const showDelete = computed({
  get: () => confirmDelete.value !== null,
  set: (v) => {
    if (!v) confirmDelete.value = null;
  },
});

async function handleDelete(row: MemoryRow) {
  switch (row.__kind) {
    case "focus":
      await deleteFocus(row.key);
      break;
    case "shared":
      await deleteShared(row.id);
      break;
    case "context":
      await deleteContext(row.id);
      break;
    case "archive":
      await deleteArchive(row.id);
      break;
    case "agent":
      await deleteAgent(row.id);
      break;
  }
  confirmDelete.value = null;
}

function fmtTs(ts: number): string {
  return new Date(ts * 1000).toLocaleString("ru-RU", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const TABS: { id: MemoryTab; label: string }[] = [
  { id: "focus", label: "🎯 Focus" },
  { id: "shared", label: "👤 Shared" },
  { id: "context", label: "📝 Context" },
  { id: "archive", label: "📚 Archive" },
  { id: "agent", label: "🤖 Agent" },
  { id: "log", label: "📜 Log" },
];

onMounted(() => {
  loadActive();
});

// Reload when page / filter changes
watch([page, agentFilter, logSessionFilter], () => {
  loadActive();
});

function onSearchSubmit() {
  page.value = 1;
  loadActive();
}

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

const pageCount = computed(() =>
  Math.max(1, Math.ceil(totalForActive.value / pageSize.value)),
);
</script>

<template>
  <div class="flex h-dvh">
    <!-- Sidebar overlay on mobile -->
    <div
      v-if="sidebarOpen"
      class="fixed inset-0 z-40 bg-black/40 md:hidden"
      @click="sidebarOpen = false"
    />

    <!-- Left: chat sidebar (so user can jump back to chats) -->
    <div
      class="w-64 min-w-64 border-r border-(--ui-border) bg-(--ui-bg-elevated) transition-transform duration-200"
      :class="[
        sidebarOpen ? 'fixed inset-y-0 left-0 z-50' : 'hidden',
        'md:relative md:block md:translate-x-0',
      ]"
    >
      <ChatSidebar @select="sidebarOpen = false" />
    </div>

    <!-- Main -->
    <div class="flex-1 flex flex-col min-w-0">
      <!-- Header -->
      <div
        class="h-12 border-b border-(--ui-border) flex items-center gap-2 px-4"
      >
        <UButton
          icon="i-lucide-menu"
          variant="ghost"
          size="sm"
          class="md:hidden"
          @click="sidebarOpen = !sidebarOpen"
        />
        <span class="text-lg">🧠 Память</span>
        <span class="text-xs text-(--ui-text-muted) ml-auto">
          {{ totalForActive }} записей
          <span v-if="loading" class="ml-2">· загрузка…</span>
        </span>
      </div>

      <!-- Tabs -->
      <div class="flex border-b border-(--ui-border) text-sm">
        <button
          v-for="tab in TABS"
          :key="tab.id"
          class="flex-1 py-2 transition-colors"
          :class="
            activeTab === tab.id
              ? 'text-(--ui-text) border-b-2 border-(--ui-primary)'
              : 'text-(--ui-text-muted) hover:text-(--ui-text)'
          "
          @click="switchTab(tab.id)"
        >
          {{ tab.label }}
        </button>
      </div>

      <!-- Filters -->
      <div
        class="px-4 py-2 border-b border-(--ui-border) flex flex-wrap items-center gap-2"
      >
        <UInput
          v-if="['shared', 'context', 'archive'].includes(activeTab)"
          v-model="search"
          placeholder="Поиск (FTS)…"
          icon="i-lucide-search"
          size="sm"
          class="flex-1 min-w-48"
          @keydown.enter="onSearchSubmit"
        />
        <select
          v-if="activeTab === 'agent'"
          v-model="agentFilter"
          class="text-sm rounded border border-(--ui-border) bg-(--ui-bg) px-2 py-1"
        >
          <option value="">Все агенты</option>
          <option v-for="id in agentIds" :key="id" :value="id">{{ id }}</option>
        </select>
        <select
          v-if="activeTab === 'log'"
          v-model="logSessionFilter"
          class="text-sm rounded border border-(--ui-border) bg-(--ui-bg) px-2 py-1 max-w-72"
        >
          <option value="">Все сессии</option>
          <option v-for="s in logSessions" :key="s" :value="s">
            {{ s.slice(0, 28) }}
          </option>
        </select>

        <div class="ml-auto flex items-center gap-2 text-xs">
          <button
            class="px-2 py-1 rounded border border-(--ui-border) disabled:opacity-40"
            :disabled="page <= 1"
            @click="page--"
          >
            ←
          </button>
          <span>{{ page }} / {{ pageCount }}</span>
          <button
            class="px-2 py-1 rounded border border-(--ui-border) disabled:opacity-40"
            :disabled="page >= pageCount"
            @click="page++"
          >
            →
          </button>
        </div>
      </div>

      <div
        v-if="error"
        class="px-4 py-2 bg-red-500/10 text-red-400 text-xs border-b border-red-500/30"
      >
        ⚠️ {{ error }}
      </div>

      <!-- Body: list + editor -->
      <div class="flex-1 flex overflow-hidden">
        <!-- List -->
        <div class="flex-1 overflow-y-auto">
          <template v-if="activeTab === 'focus'">
            <MemoryRow
              v-for="entry in focus"
              :key="entry.key"
              :row="{ __kind: 'focus', ...entry }"
              :selected="
                selected?.__kind === 'focus' && selected.key === entry.key
              "
              :title="rowTitle({ __kind: 'focus', ...entry })"
              :badge="'key'"
              :badge-color="'text-yellow-400'"
              :preview="entry.value"
              @select="select({ __kind: 'focus', ...entry })"
              @delete="confirmDelete = { __kind: 'focus', ...entry }"
            />
          </template>

          <template v-else-if="activeTab === 'shared'">
            <MemoryRow
              v-for="row in shared.items"
              :key="row.id"
              :row="{ __kind: 'shared', ...row }"
              :selected="
                selected?.__kind === 'shared' && selected.id === row.id
              "
              :title="rowTitle({ __kind: 'shared', ...row })"
              :badge="rowBadge({ __kind: 'shared', ...row })"
              :badge-color="badgeColor({ __kind: 'shared', ...row })"
              :ts="row.updated_at"
              @select="select({ __kind: 'shared', ...row })"
              @delete="confirmDelete = { __kind: 'shared', ...row }"
            />
          </template>

          <template v-else-if="activeTab === 'context'">
            <MemoryRow
              v-for="row in context.items"
              :key="row.id"
              :row="{ __kind: 'context', ...row }"
              :selected="
                selected?.__kind === 'context' && selected.id === row.id
              "
              :title="rowTitle({ __kind: 'context', ...row })"
              :badge="rowBadge({ __kind: 'context', ...row })"
              :badge-color="badgeColor({ __kind: 'context', ...row })"
              :ts="row.updated_at"
              @select="select({ __kind: 'context', ...row })"
              @delete="confirmDelete = { __kind: 'context', ...row }"
            />
          </template>

          <template v-else-if="activeTab === 'archive'">
            <MemoryRow
              v-for="row in archive.items"
              :key="row.id"
              :row="{ __kind: 'archive', ...row }"
              :selected="
                selected?.__kind === 'archive' && selected.id === row.id
              "
              :title="rowTitle({ __kind: 'archive', ...row })"
              :badge="rowBadge({ __kind: 'archive', ...row })"
              :badge-color="badgeColor({ __kind: 'archive', ...row })"
              :ts="row.updated_at"
              @select="select({ __kind: 'archive', ...row })"
              @delete="confirmDelete = { __kind: 'archive', ...row }"
            />
          </template>

          <template v-else-if="activeTab === 'agent'">
            <MemoryRow
              v-for="row in agent.items"
              :key="row.id"
              :row="{ __kind: 'agent', ...row }"
              :selected="
                selected?.__kind === 'agent' && selected.id === row.id
              "
              :title="rowTitle({ __kind: 'agent', ...row })"
              :badge="rowBadge({ __kind: 'agent', ...row })"
              :badge-color="badgeColor({ __kind: 'agent', ...row })"
              :ts="row.updated_at"
              @select="select({ __kind: 'agent', ...row })"
              @delete="confirmDelete = { __kind: 'agent', ...row }"
            />
          </template>

          <template v-else-if="activeTab === 'log'">
            <MemoryRow
              v-for="row in log.items"
              :key="row.id"
              :row="{ __kind: 'log', ...row }"
              :selected="selected?.__kind === 'log' && selected.id === row.id"
              :title="rowTitle({ __kind: 'log', ...row })"
              :badge="rowBadge({ __kind: 'log', ...row })"
              :badge-color="badgeColor({ __kind: 'log', ...row })"
              :ts="row.created_at"
              :deletable="false"
              @select="select({ __kind: 'log', ...row })"
            />
          </template>

          <div
            v-if="totalForActive === 0 && !loading"
            class="text-center text-(--ui-text-dimmed) text-sm py-10"
          >
            Пусто
          </div>
        </div>

        <!-- Editor / Viewer -->
        <div
          v-if="selected"
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
              {{ fmtTs((selected as any).updated_at) }}
            </span>
            <button
              class="text-(--ui-text-muted) hover:text-(--ui-text)"
              title="Закрыть"
              @click="select(null)"
            >
              <UIcon name="i-lucide-x" class="size-4" />
            </button>
          </div>

          <!-- Focus editor -->
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

          <!-- Shared editor -->
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

          <!-- Context / Archive editor -->
          <template
            v-else-if="
              selected.__kind === 'context' || selected.__kind === 'archive'
            "
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

          <!-- Agent editor -->
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

          <!-- Log viewer (read-only) -->
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

          <!-- Actions -->
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
              @click="confirmDelete = selected"
            />
          </div>
        </div>
      </div>

      <!-- Delete confirm modal -->
      <UModal v-model:open="showDelete" title="Удалить запись?">
        <template #body>
          <p class="text-sm text-(--ui-text-muted)">
            Отменить нельзя. Запись будет удалена из памяти.
          </p>
        </template>
        <template #footer>
          <div class="flex gap-2 justify-end">
            <UButton
              variant="ghost"
              label="Отмена"
              @click="confirmDelete = null"
            />
            <UButton
              color="error"
              label="Удалить"
              @click="confirmDelete && handleDelete(confirmDelete)"
            />
          </div>
        </template>
      </UModal>
    </div>
  </div>
</template>
