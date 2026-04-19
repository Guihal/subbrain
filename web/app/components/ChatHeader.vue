<script setup lang="ts">
const { currentModel, directMode, agentMode, models } = useChat();

const modelItems = computed(() =>
  models.value.map((m) => ({
    label: m.label,
    value: m.value,
    description: m.description,
  })),
);
</script>

<template>
  <header
    class="flex items-center gap-3 px-4 py-2.5 border-b border-(--ui-border) bg-(--ui-bg-elevated) shrink-0"
  >
    <slot name="leading" />

    <h1 class="text-base font-semibold flex items-center gap-2">
      🧠 <span>Subbrain</span>
    </h1>

    <USelectMenu
      v-model="currentModel"
      :items="modelItems"
      value-key="value"
      class="w-48"
      size="sm"
    />

    <div class="flex-1" />

    <USwitch v-model="agentMode" label="Agent" size="sm" />
    <USwitch v-model="directMode" label="Direct" size="sm" />
  </header>
</template>
