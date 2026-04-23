<script setup lang="ts">
const category = defineModel<string>("category", { default: "" });
const content = defineModel<string>("content", { default: "" });
const tags = defineModel<string>("tags", { default: "" });
defineEmits<{ change: [] }>();
</script>

<template>
  <label class="text-xs text-(--ui-text-muted)">Категория</label>
  <UInput v-model="category" size="sm" @update:model-value="$emit('change')" />
  <label class="text-xs text-(--ui-text-muted)">Контент</label>
  <UTextarea
    v-model="content"
    :rows="6"
    size="sm"
    @update:model-value="$emit('change')"
  />
  <label class="text-xs text-(--ui-text-muted)">Теги</label>
  <UInput v-model="tags" size="sm" @update:model-value="$emit('change')" />
</template>
