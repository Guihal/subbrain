<script setup lang="ts">
// M-12 (mig 15): archive confidence is REAL [0..1] | null. Renders as a
// number input with step=0.05; null state = "—" placeholder. Route
// validates `t.Number({minimum:0, maximum:1})`.
const title = defineModel<string>("title", { default: "" });
const content = defineModel<string>("content", { default: "" });
const tags = defineModel<string>("tags", { default: "" });
const confidence = defineModel<number | null>("confidence", { default: null });
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
  <label class="text-xs text-(--ui-text-muted)">Уверенность (0..1)</label>
  <UInput
    v-model.number="confidence"
    type="number"
    min="0"
    max="1"
    step="0.05"
    size="sm"
    placeholder="—"
    @update:model-value="$emit('change')"
  />
</template>
