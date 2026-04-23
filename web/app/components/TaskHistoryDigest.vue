<script setup lang="ts">
defineProps<{
  title: string;
  content: string;
  createdAt: number;
}>();

const mskDate = new Intl.DateTimeFormat("ru-RU", {
  timeZone: "Europe/Moscow",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
</script>

<template>
  <tr class="digest-row">
    <td colspan="7">
      <details>
        <summary>
          📦 {{ title }}
          <span class="text-(--ui-text-muted) text-xs">
            · {{ mskDate.format(createdAt * 1000) }}
          </span>
        </summary>
        <pre class="digest-content">{{ content }}</pre>
      </details>
    </td>
  </tr>
</template>

<style scoped>
.digest-row td {
  padding: 0.25rem 0.6rem;
  border-bottom: 1px solid var(--ui-border);
}
.digest-content {
  white-space: pre-wrap;
  font-size: 0.75rem;
  color: var(--ui-text-muted);
  padding: 0.5rem;
  background: var(--ui-bg-accented);
  border-radius: 0.25rem;
  margin-top: 0.25rem;
}
</style>
