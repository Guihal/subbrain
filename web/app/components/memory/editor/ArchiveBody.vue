<script setup lang="ts">
const title = defineModel<string>("title", { default: "" });
const content = defineModel<string>("content", { default: "" });
const tags = defineModel<string>("tags", { default: "" });
const confidence = defineModel<"HIGH" | "LOW">("confidence", { default: "LOW" });
defineEmits<{ change: [] }>();
</script>

<template>
  <label class="text-xs text-(--ui-text-muted)">Заголовок</label>
  <UInput v-model="title" size="sm" @update:model-value="$emit('change')" />
  <label class="text-xs text-(--ui-text-muted)">Контент</label>
  <UTextarea
    v-model="content"
    :rows="10"
    size="sm"
    @update:model-value="$emit('change')"
  />
  <label class="text-xs text-(--ui-text-muted)">Теги</label>
  <UInput v-model="tags" size="sm" @update:model-value="$emit('change')" />
  <label class="text-xs text-(--ui-text-muted)">Уверенность</label>
  <select
    v-model="confidence"
    class="w-full text-sm rounded border border-(--ui-border) bg-(--ui-bg) px-2 py-1"
    @change="$emit('change')"
  >
    <option value="HIGH">HIGH</option>
    <option value="LOW">LOW</option>
  </select>
</template>
