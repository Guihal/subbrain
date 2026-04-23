<script setup lang="ts">
defineProps<{ dirty: boolean }>();
defineEmits<{ save: []; delete: [] }>();
</script>

<template>
  <div class="flex items-center gap-2 pt-2 border-t border-(--ui-border)">
    <UButton
      size="sm"
      :disabled="!dirty"
      icon="i-lucide-save"
      label="Сохранить"
      @click="$emit('save')"
    />
    <UButton
      size="sm"
      variant="ghost"
      color="error"
      icon="i-lucide-trash-2"
      label="Удалить"
      class="ml-auto"
      @click="$emit('delete')"
    />
  </div>
</template>
