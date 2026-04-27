<script setup lang="ts">
import type { MemoryRow } from "~/composables/useMemory";

defineProps<{ row: MemoryRow | null }>();
const open = defineModel<boolean>("open", { required: true });
const emit = defineEmits<{ cancel: []; confirm: [row: MemoryRow] }>();
</script>

<template>
  <UModal v-model:open="open" title="Удалить запись?">
    <template #body>
      <p class="text-sm text-(--ui-text-muted)">
        Отменить нельзя. Запись будет удалена из памяти.
      </p>
    </template>
    <template #footer>
      <div class="flex gap-2 justify-end">
        <UButton variant="ghost" label="Отмена" @click="emit('cancel')" />
        <UButton
          color="error"
          label="Удалить"
          @click="row && emit('confirm', row)"
        />
      </div>
    </template>
  </UModal>
</template>
