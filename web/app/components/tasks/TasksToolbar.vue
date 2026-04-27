<script setup lang="ts">
defineProps<{
  searchQuery: string;
}>();

const sidebarOpen = defineModel<boolean>("sidebarOpen", { required: true });

const emit = defineEmits<{
  "update:searchQuery": [value: string];
  openNew: [];
}>();
</script>

<template>
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
    <span class="text-lg">📋 Задачи</span>
    <input
      :value="searchQuery"
      placeholder="Поиск по странице…"
      class="ml-3 px-2 py-1 text-sm bg-(--ui-bg) border border-(--ui-border) rounded"
      @input="emit('update:searchQuery', ($event.target as HTMLInputElement).value)"
    >
    <div class="ml-auto">
      <UButton
        icon="i-lucide-plus"
        label="Новая"
        size="sm"
        @click="emit('openNew')"
      />
    </div>
  </header>
</template>
