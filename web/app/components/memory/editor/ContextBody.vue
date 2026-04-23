<script setup lang="ts">
const title = defineModel<string>("title", { default: "" });
const content = defineModel<string>("content", { default: "" });
const tags = defineModel<string>("tags", { default: "" });
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
</template>
