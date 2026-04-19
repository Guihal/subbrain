# 11 — Code Tools: Самописные инструменты агента

## Концепция

Агент может **писать TypeScript-код** как полноценные исполняемые инструменты.
Код сохраняется в SQLite, выполняется в изолированном sandbox (Bun Worker),
персистится между сессиями.

Вдохновлено: OpenClaw Skills, dynamic tools (уже есть prompt-шаблоны),
но теперь — реальный исполняемый код.

---

## Phase 1: Sandbox для кода (MVP)

### Новая таблица

```sql
CREATE TABLE code_tools (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  description TEXT NOT NULL,
  code TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  run_count INTEGER DEFAULT 0,
  error_count INTEGER DEFAULT 0,
  last_run_at INTEGER,
  last_error TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);
```

### Новые agent tools

| Tool | Описание |
|------|----------|
| `create_code_tool` | Создать исполняемый инструмент (name, description, code) |
| `edit_code_tool` | Изменить код существующего инструмента |
| `delete_code_tool` | Удалить инструмент |
| `test_code_tool` | Запустить с тестовым input, вернуть output |
| `list_code_tools` | Показать все code tools (имя, описание, статистика) |

### Sandbox (Bun Worker)

- Код выполняется как `export default async (input: string) => string`
- Имеет доступ к: `fetch`, `JSON`, `Date`, `Math`, `URL`, `URLSearchParams`
- **НЕ** имеет доступ к: файловой системе, `process`, `Bun.file`, `require`
- Таймаут: 30 секунд
- Размер output: max 10KB (обрезается)

### Структура файлов

```
src/pipeline/agent-loop/
  code-tools/
    index.ts        — CodeToolRegistry: CRUD + list
    sandbox.ts      — Bun Worker-based isolated executor
    types.ts        — CodeTool interface, результат выполнения
```

### Интеграция

- `AgentLoop` получает `CodeToolRegistry`
- `getAllTools()` включает code tools как обычные tools
- При вызове code tool → `sandbox.execute(code, input)` → результат
- Auto-disable: если error_count >= 3 → enabled = false, уведомление в TG

---

## Phase 2: Tool evolution

- Агент может редактировать существующие code tools (`edit_code_tool`)
- Версионирование: каждое изменение → новая запись в `code_tool_versions`
- Лог использования: run_count, avg_duration, success_rate
- Автоматический rollback: если новая версия падает → откат к предыдущей

---

## Phase 3: Scheduled tools (cron)

- Поле `schedule` в code_tools (cron-выражение, опционально)
- Scheduler проверяет каждую минуту: какие tools нужно запустить
- Примеры:
  - "Каждое утро проверяй HH по моему стеку"
  - "Каждый час мониторь цены на Upwork"
  - "Раз в день делай дайджест новостей"
- Результат scheduled tool → tg_send_message + memory_write

---

## Phase 4: Composability & sharing

- Tools могут вызывать другие tools (через `context.callTool(name, input)`)
- Экспорт tool как `.ts` файл / JSON bundle
- Импорт community tools
- Agent сам компилирует "Wiki" из опыта работы с tools

---

## Сравнение с OpenClaw

| Аспект | OpenClaw | Subbrain Code Tools |
|--------|----------|---------------------|
| Формат | SOUL.md + SKILL.md (файлы) | SQLite + Bun Worker |
| Язык | Markdown config | TypeScript (реальный код) |
| Isolation | Docker container | Bun Worker (lightweight) |
| Self-modify | Нет (только конфиг) | Да (агент пишет/правит код) |
| Scheduling | HEARTBEAT.md (весь агент) | Per-tool cron |
| Memory | Memory Wiki (статичный) | 4-слойная RAG (динамичная) |
| Execution | Gateway + SKILL registry | Inline в agent-loop |
