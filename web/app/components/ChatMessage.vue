<script setup lang="ts">
import type { ChatMessage } from "~/composables/useChat";

const props = defineProps<{
  message: ChatMessage;
  isStreaming?: boolean;
}>();

const { render } = useMarkdown();

const thinkingCollapsed = ref(true);

const renderedContent = computed(() => {
  // Strip any residual <think> tags that weren't extracted during streaming
  const clean = props.message.content
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .trim();
  return render(clean);
});
const renderedReasoning = computed(() =>
  props.message.reasoning ? render(props.message.reasoning) : "",
);

const hasReasoning = computed(() => !!props.message.reasoning?.trim());
</script>

<template>
  <div
    class="flex"
    :class="message.role === 'user' ? 'justify-end' : 'justify-start'"
  >
    <div
      class="max-w-[80%] rounded-xl px-4 py-3 text-sm leading-relaxed"
      :class="
        message.role === 'user'
          ? 'bg-(--ui-bg-accented) rounded-br-sm'
          : 'bg-(--ui-bg-elevated) border border-(--ui-border) rounded-bl-sm'
      "
    >
      <!-- Reasoning/Thinking -->
      <div v-if="hasReasoning && message.role === 'assistant'" class="mb-2">
        <button
          class="text-xs text-(--ui-text-muted) hover:text-(--ui-text) transition-colors mb-1 flex items-center gap-1"
          @click="thinkingCollapsed = !thinkingCollapsed"
        >
          <UIcon
            :name="
              thinkingCollapsed
                ? 'i-lucide-chevron-right'
                : 'i-lucide-chevron-down'
            "
            class="size-3"
          />
          💭 Размышления
        </button>
        <div
          class="thinking-block pl-3 text-xs text-(--ui-text-muted) leading-relaxed"
          :class="{ collapsed: thinkingCollapsed }"
          v-html="renderedReasoning"
        />
      </div>

      <!-- Content -->
      <div v-if="message.role === 'user'" class="whitespace-pre-wrap">
        {{ message.content }}
      </div>
      <div v-else class="msg-content" v-html="renderedContent" />

      <!-- Streaming indicator -->
      <div v-if="isStreaming && !message.content" class="flex gap-1 mt-1">
        <span
          class="size-1.5 rounded-full bg-(--ui-text-muted) animate-pulse"
        />
        <span
          class="size-1.5 rounded-full bg-(--ui-text-muted) animate-pulse"
          style="animation-delay: 0.15s"
        />
        <span
          class="size-1.5 rounded-full bg-(--ui-text-muted) animate-pulse"
          style="animation-delay: 0.3s"
        />
      </div>
    </div>
  </div>
</template>
