<script setup lang="ts">
defineProps<{
  modelValue: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  confirmColor?: "error" | "warning" | "primary";
}>();
const emit = defineEmits<{
  "update:modelValue": [value: boolean];
  confirm: [];
}>();
</script>

<template>
  <UModal
    :open="modelValue"
    :title="title"
    @update:open="emit('update:modelValue', $event)"
  >
    <template #body>
      <p class="text-sm text-(--ui-text-muted)">{{ message }}</p>
    </template>
    <template #footer>
      <div class="flex gap-2 justify-end">
        <UButton
          variant="ghost"
          label="Отмена"
          @click="emit('update:modelValue', false)"
        />
        <UButton
          :color="confirmColor ?? 'primary'"
          :label="confirmLabel"
          @click="emit('confirm')"
        />
      </div>
    </template>
  </UModal>
</template>
