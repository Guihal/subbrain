<script setup lang="ts">
import type { CreateBody, PatchBody, TaskRow, TaskScope } from "~/types/task";

const props = defineProps<{
  modelValue: boolean;
  task?: TaskRow | null;
}>();
const emit = defineEmits<{
  "update:modelValue": [value: boolean];
  submit: [body: CreateBody | PatchBody, isEdit: boolean];
}>();

const title = ref("");
const description = ref("");
const scope = ref<TaskScope>("global");
const priority = ref(0);
const dueLocal = ref("");

const isEdit = computed(() => props.task !== null && props.task !== undefined);

function unixToLocalMsk(unix: number | null): string {
  if (unix === null) return "";
  return new Date(unix * 1000 + 3 * 3600 * 1000).toISOString().slice(0, 16);
}

function localMskToUnix(local: string): number | null {
  if (!local) return null;
  const norm = local.slice(0, 16);
  const d = new Date(`${norm}:00+03:00`);
  return Number.isFinite(d.getTime()) ? Math.floor(d.getTime() / 1000) : null;
}

function resetForm() {
  if (props.task) {
    title.value = props.task.title;
    description.value = props.task.description;
    scope.value = props.task.scope;
    priority.value = props.task.priority;
    dueLocal.value = unixToLocalMsk(props.task.due_at);
  } else {
    title.value = "";
    description.value = "";
    scope.value = "global";
    priority.value = 0;
    dueLocal.value = "";
  }
}

watch(
  () => props.modelValue,
  (open) => {
    if (open) resetForm();
  },
);

const open = computed({
  get: () => props.modelValue,
  set: (v) => emit("update:modelValue", v),
});

function onSubmit() {
  if (!title.value.trim()) return;
  const body: CreateBody | PatchBody = {
    title: title.value.trim(),
    description: description.value,
    priority: priority.value,
    due_at: localMskToUnix(dueLocal.value),
  };
  if (!isEdit.value) {
    (body as CreateBody).scope = scope.value;
  }
  emit("submit", body, isEdit.value);
}

function onCancel() {
  open.value = false;
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="isEdit ? 'Редактировать задачу' : 'Новая задача'"
  >
    <template #body>
      <form class="task-form" @submit.prevent="onSubmit">
        <label>
          <span>Название</span>
          <input
            v-model="title"
            type="text"
            maxlength="200"
            required
            class="form-input"
          >
        </label>

        <label v-if="!isEdit">
          <span>Scope</span>
          <select v-model="scope" class="form-input">
            <option v-for="s in TASK_SCOPES" :key="s" :value="s">
              {{ s }}
            </option>
          </select>
        </label>

        <label>
          <span>Приоритет: {{ priority }}</span>
          <input
            v-model.number="priority"
            type="range"
            min="0"
            max="10"
            step="1"
          >
        </label>

        <label>
          <span>Дедлайн (MSK)</span>
          <input v-model="dueLocal" type="datetime-local" class="form-input">
        </label>

        <label>
          <span>Описание</span>
          <textarea v-model="description" rows="4" class="form-input" />
        </label>
      </form>
    </template>

    <template #footer>
      <div class="flex gap-2 justify-end">
        <UButton variant="ghost" label="Отмена" @click="onCancel" />
        <UButton
          :label="isEdit ? 'Сохранить' : 'Создать'"
          :disabled="!title.trim()"
          @click="onSubmit"
        />
      </div>
    </template>
  </UModal>
</template>

<style scoped>
.task-form {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.task-form label {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.85rem;
}
.task-form label > span {
  color: var(--ui-text-muted);
  font-size: 0.75rem;
}
.form-input {
  background: var(--ui-bg);
  border: 1px solid var(--ui-border);
  border-radius: 0.35rem;
  padding: 0.4rem 0.6rem;
  color: var(--ui-text);
  font-size: 0.85rem;
}
.form-input:focus {
  outline: 2px solid var(--ui-primary);
  outline-offset: -1px;
}
textarea.form-input {
  resize: vertical;
  min-height: 4rem;
  max-height: 20rem;
}
</style>
