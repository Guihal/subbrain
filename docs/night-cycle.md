# Night cycle

Ночной pipeline (`src/pipeline/night-cycle/`) сжимает свежие логи в `layer3_archive`, чистит противоречия/дубли, и выполняет retention по всем слоям памяти + таблице `tasks`. Запускается через HTTP `POST /night-cycle` (системный cron-guard) или in-process scheduler (`NIGHT_CYCLE_HOUR_UTC`, default `3`).

## Steps

| # | Step | Назначение |
|---|------|-----------|
| 1 | scrubPII | Удаляет PII из `layer4_log` conversation текста. |
| 2 | translate | Приводит сессию к EN (устойчивый vocab для embed). |
| 3 | compress | Сжимает conversation → `{title, content, tags, ...}` для archive. |
| 4 | verify | Факт-чек compression result vs source. |
| 5 | dedup | FTS-поиск по archive → если уже есть — skip insert. |
| 6 | extractAntiPatterns | Агрегирует повторяющиеся ошибки/грабли за окно. |
| 7 | resolveContradictions | LLM-решает конфликты между archive/shared. |
| 8 | pruneShared | Сливает/удаляет дубли в `shared_memory`. |
| 9 | pruneContext | То же для `layer2_context`. |
| 10 | pruneFocus | Сливает/удаляет устаревшие ключи в `layer1_focus`. |
| 11 | pruneCompletedTasks | Weekly digest для `done` > 7d + DELETE `cancelled` > 1d. |
| 12 | collectStrayTasks | Переносит task-like строки из shared/context в `tasks`. |

## Step 11 — weekly digest week numbering

Группировка done-задач происходит по SQL-выражению `strftime('%Y-W%W', completed_at, 'unixepoch')`. SQLite `%W` — это **Monday-based ordinal week** (`00..53`), НЕ ISO-8601. Последствия:

- `00` — дни января до первого понедельника года (например Jan 1-4 2026 → `2026-W00`).
- Неделя может пересечь границу года. `2025-W52` digest может содержать задачи, завершённые 29 декабря; `2026-W00` — с 1 января.
- Label в теге — lowercase: `tasks,digest,YYYY-wNN` (визуально отличается от ISO-шного `YYYY-Www`).
- Bucket decision считается полностью на стороне SQLite в UTC — JS `Date` не участвует, поэтому TZ-консистентность сохраняется.

### Dedup + unbounded growth

Задачи той же календарной недели, завершённые ближе к границе окна (< 7d назад), на первом цикле не попадают в digest. Следующий ночной цикл добавит их в **тот же** digest entry: lookup идёт по `WHERE tags = 'tasks,digest,<label>' AND agent_id = 'night-cycle'`. Обновление = `updateArchive({content: combined})` + re-embed + `upsertEmbedding`, DELETE tasks — всё в одной транзакции.

Combined content capped at 50 KB: при превышении мы дропаем самые старые строки (keep-tail), prefix `"Completed ~N tasks (showing most recent M):\n"`. Защищает embed-call от token-limit и базу от unbounded growth через серию update'ов.

Embed вызывается **вне** транзакции; при неудаче DELETE не выполняется, tasks остаются, retry — в следующем цикле.

## Step 12 — stray tasks collection

Раз за ночь сканирует записи в `shared_memory` + `layer2_context`, созданные за последнее окно (state-tracked через focus-key `night.stray_tasks.last_run_at`, cap `MAX_WINDOW_SECONDS=7*86400`). Фильтр: tags содержат `task|todo|reminder|deadline|дедлайн|задача` И не содержат `architecture|design|pattern|how-to`. Каждая строка классифицируется LLM (`NIGHT_CYCLE_MODEL`, default `coder`) → `migrate` переносит её в `tasks` (`source="stray:<table>:<id>"`) + удаляет источник в транзакции.

Focus-key `night.stray_tasks.last_run_at` защищён в `PROTECTED_FOCUS_KEYS` (`prune/focus.ts`) — pruneFocus не трогает. Если Step 12 упал с exception — key не обновляется, окно пересечётся на следующем успешном цикле (backfill). При длинном простое (>7d) старые строки уйдут за cap и не попадут в скан — Step 12 advisory, не critical path.

Cap: `MAX_PER_CYCLE=20`, `MAX_DURATION_MS=3min`. Остаток попадёт следующим циклом.

## One-shot migration

Для существующих баз с историческими task-like записями до Phase-1:

```bash
bun run scripts/migrate-tasks-from-memory.ts           # dry-run
bun run scripts/migrate-tasks-from-memory.ts --apply   # mutate
```

Пишет JSONL-лог в `scripts/migration-log/tasks-YYYY-MM-DD.jsonl` на каждый migrated row. Откат:

```bash
bun run scripts/rollback-migration.ts scripts/migration-log/tasks-YYYY-MM-DD.jsonl
```
