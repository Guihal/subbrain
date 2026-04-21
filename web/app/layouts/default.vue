<script setup lang="ts">
const sidebarOpen = useState("sidebar-open", () => false);
</script>

<template>
  <div class="flex h-dvh">
    <div
      v-if="sidebarOpen"
      class="fixed inset-0 z-40 bg-black/40 md:hidden"
      @click="sidebarOpen = false"
    />

    <div
      class="w-64 min-w-64 border-r border-(--ui-border) bg-(--ui-bg-elevated) transition-transform duration-200"
      :class="[
        sidebarOpen ? 'fixed inset-y-0 left-0 z-50' : 'hidden',
        'md:relative md:block md:translate-x-0',
      ]"
    >
      <ChatSidebar @select="sidebarOpen = false" />
    </div>

    <div class="flex-1 flex flex-col min-w-0">
      <slot />
    </div>
  </div>
</template>
