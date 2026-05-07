<script setup lang="ts">
const emit = defineEmits<{
  send: [text: string];
  cancel: [];
}>();

const props = defineProps<{
  disabled?: boolean;
  streaming?: boolean;
}>();

const text = ref("");
const textareaRef = ref<HTMLTextAreaElement>();

function handleSend() {
  const val = text.value.trim();
  if (!val || props.disabled) return;
  emit("send", val);
  text.value = "";
  nextTick(() => resize());
}

function handleClick() {
  if (props.streaming) {
    emit("cancel");
    return;
  }
  handleSend();
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    if (props.streaming) emit("cancel");
    else handleSend();
  }
}

function resize() {
  const el = textareaRef.value;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
}

// Focus on mount
onMounted(() => textareaRef.value?.focus());
</script>

<template>
  <div
    class="flex gap-3 px-4 py-3 border-t border-(--ui-border) bg-(--ui-bg-elevated) shrink-0"
  >
    <textarea
      ref="textareaRef"
      v-model="text"
      rows="1"
      class="flex-1 bg-(--ui-bg) text-(--ui-text) border border-(--ui-border) rounded-lg px-3.5 py-2.5 text-sm resize-none outline-none focus:border-(--ui-border-active) transition-colors placeholder:text-(--ui-text-dimmed)"
      style="min-height: 44px; max-height: 200px; line-height: 1.4"
      placeholder="Напиши сообщение…"
      :disabled="disabled && !streaming"
      @input="resize"
      @keydown="onKeydown"
    />
    <UButton
      :icon="streaming ? 'i-lucide-square' : 'i-lucide-send'"
      :color="streaming ? 'error' : 'primary'"
      :disabled="streaming ? false : (disabled || !text.trim())"
      :aria-label="streaming ? 'Остановить' : 'Отправить'"
      size="lg"
      @click="handleClick"
    />
  </div>
</template>
