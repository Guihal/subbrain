<script setup lang="ts">
defineProps<{ agentId: string }>();
const content = defineModel<string>("content", { default: "" });
const tags = defineModel<string>("tags", { default: "" });
defineEmits<{ change: [] }>();
</script>

<template>
  <label class="text-xs text-(--ui-text-muted)">Agent</label>
  <UInput :model-value="agentId" disabled size="sm" />
  <label class="text-xs text-(--ui-text-muted)">Контент</label>
  <UTextarea
    v-model="content"
    :rows="8"
    size="sm"
    @update:model-value="$emit('change')"
  />
  <label class="text-xs text-(--ui-text-muted)">Теги</label>
  <UInput v-model="tags" size="sm" @update:model-value="$emit('change')" />
</template>
