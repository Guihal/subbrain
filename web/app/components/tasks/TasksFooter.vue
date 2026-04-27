<script setup lang="ts">
defineProps<{
  hasQ: boolean;
  visibleCount: number;
  totalItemsCount: number;
  page: number;
  pageCount: number;
  loading: boolean;
}>();

const emit = defineEmits<{
  prev: [];
  next: [];
}>();
</script>

<template>
  <footer
    class="flex items-center gap-2 px-4 py-2 border-t border-(--ui-border) text-xs"
  >
    <template v-if="hasQ">
      <span class="text-(--ui-text-muted)">
        Поиск по странице: {{ visibleCount }} из {{ totalItemsCount }}.
        Для полного поиска очисти запрос.
      </span>
    </template>
    <template v-else>
      <button :disabled="page <= 1" class="px-2 py-1" @click="emit('prev')">
        ←
      </button>
      <span>Стр. {{ page }} / {{ pageCount }}</span>
      <button
        :disabled="page >= pageCount"
        class="px-2 py-1"
        @click="emit('next')"
      >
        →
      </button>
    </template>
    <span v-if="loading" class="ml-auto text-(--ui-text-muted)">
      загрузка…
    </span>
  </footer>
</template>
