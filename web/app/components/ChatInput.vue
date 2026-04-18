<script setup lang="ts">
const emit = defineEmits<{
  send: [text: string];
}>();

const props = defineProps<{
  disabled?: boolean;
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

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    handleSend();
  }
}

function resize() {
  const el = textareaRef.value;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 200) + "px";
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
      :disabled="disabled"
      @input="resize"
      @keydown="onKeydown"
    />
    <UButton
      icon="i-lucide-send"
      :disabled="disabled || !text.trim()"
      size="lg"
      @click="handleSend"
    />
  </div>
</template>
