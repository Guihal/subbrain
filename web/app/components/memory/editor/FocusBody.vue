<script setup lang="ts">
defineProps<{ rowKey: string }>();
const value = defineModel<string>("value", { default: "" });
defineEmits<{ change: [] }>();
</script>

<template>
  <label class="text-xs text-(--ui-text-muted)">Ключ</label>
  <UInput :model-value="rowKey" disabled size="sm" />
  <label class="text-xs text-(--ui-text-muted)">Значение</label>
  <UTextarea
    v-model="value"
    :rows="4"
    size="sm"
    @update:model-value="$emit('change')"
  />
</template>
