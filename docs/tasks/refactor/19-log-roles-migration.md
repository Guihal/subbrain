# Задача 19 — Log roles migration + fix swallow (OBS-1)

**Оценка:** 2 часа
**Зависимости:** —
**Status:** DONE (PR #19)

> Примечание к реализации: слот `PRAGMA user_version = 6` уже был занят
> миграцией tasks/scheduler_state (из `feat(tasks): web UI + night weekly
> digest + stray collection`), поэтому PR 19 реализован как **migration 7**.
> Паттерн (CREATE _new + INSERT SELECT + DROP/RENAME + индексы, весь блок
> под `db.transaction(() => { .run() })`) и набор ролей в CHECK — те же,
> что описаны ниже.

## Цель

Слой наблюдаемости иллюзорен: каждый `logger.info/warn/error` с включённым DB-бэкапом (default-режим) **молча проваливается**.

- [packages/core/packages/core/src/db/schema.ts:305](../../../packages/core/packages/core/src/db/schema.ts#L305) — `CHECK(role IN ('user','assistant','system','tool','reasoning'))`.
- [packages/core/src/lib/logger.ts:75](../../../packages/core/src/lib/logger.ts#L75) — `memory.appendLog(..., \`_log_\${entry.level}\`, content)`. Role получается `_log_info` / `_log_warn` / `_log_error` / `_log_debug` → CHECK violation, SQLite бросает.
- [packages/core/src/lib/logger.ts:78](../../../packages/core/src/lib/logger.ts#L78) — `catch {}` полностью глотает. Ни одна запись в Layer 4 от logger'а не доходит.
- [packages/agent/packages/agent/src/telegram/userbot/index.ts:319-325](../../../packages/agent/packages/agent/src/telegram/userbot/index.ts#L319-L325) — role `channel_message`. Тот же провал.

Итог: Layer 4 содержит только то, что пишет pipeline напрямую (user/assistant/tool messages). Весь logger-трафик и все telegram-monitor события теряются без единого звука.

## Файлы

- [packages/core/packages/core/src/db/schema.ts](../../../packages/core/packages/core/src/db/schema.ts) — migration 6.
- [packages/core/src/lib/logger.ts](../../../packages/core/src/lib/logger.ts) — fix swallow.

## Изменение

### 1. Migration 6 (расширение CHECK)

По паттерну migration 3 (в том же файле):

```
CREATE TABLE layer4_log_new (
  ...,
  role TEXT NOT NULL CHECK(role IN (
    'user','assistant','system','tool','reasoning',
    '_log_debug','_log_info','_log_warn','_log_error',
    'channel_message'
  )),
  ...
);
INSERT INTO layer4_log_new SELECT * FROM layer4_log;
DROP TABLE layer4_log;
ALTER TABLE layer4_log_new RENAME TO layer4_log;
-- пересоздать все индексы (idx_log_request, idx_log_session, idx_log_agent, idx_log_created)
PRAGMA user_version = 6;
```

Всё внутри `db.transaction(() => { for (const sql of mig6Stmts) db.query(sql).run(); })()` — гарантирует atomic и per-statement `.run()` (см. guardrail `4` — никогда `db.exec` multi-statement).

### 2. Fix silent swallow в `logger.ts:78`

Текущий `catch {}` оставить по сути (не ломать flow приложения), но **на первой constraint-violation per unique role per process** логнуть в `console.error` один раз:

- Module-level `Set<string>` — запомненные уже-предупреждённые role-строки.
- В catch: если `err.message` содержит `CHECK constraint failed` **и** role ещё не в Set → `console.error("[logger] Layer4 role rejected: ${role}")`, добавить в Set.
- Повторы — silent как раньше.

Задача этого шага — сделать будущий role-drift видимым. Не спамить логи.

### 3. Архитектурный долг (не в рамках PR)

`channel_message` семантически — **тип сообщения**, не role. Правильный фикс: ввести колонку `msg_type`, либо писать role=`tool` с content-prefix `[channel_message] ...`. Это переработка layer4_log схемы + все читатели (web UI, night-cycle post-processor). Вне scope PR 19. В [docs/02-audit.md](../../02-audit.md) добавить OBS-2 как follow-up.

## Тесты

`tests/schema-migrations.test.ts`:

- Применить migrations на пустой `data/test.db` → `PRAGMA user_version` = 6 (или выше, если появится 7+).
- `INSERT INTO layer4_log(..., role='_log_info', ...)` проходит.
- `INSERT ... role='channel_message'` проходит.
- `INSERT ... role='garbage_role'` → throws CHECK violation.

`tests/logger-swallow.test.ts`:

- Attach memory с CHECK constraint. Вызвать `logger.info("x", "y")` с role, который сам logger успешно проведёт (через migration уже corrent) — должен писать.
- Инъекция: monkey-patch `memory.appendLog` чтоб бросить раз на role='_log_xxx'. Assert `console.error` called ровно 1 раз для первой ошибки, 0 раз на второй с той же role.

## Приёмка

- [ ] `bunx tsc --noEmit` = 0.
- [ ] Новые тесты зелёные.
- [ ] Прод-снэпшот (копия `data/subbrain.db`) проходит migrate() без ошибок.
- [ ] `bun run scripts/audit-db.ts` после миграции показывает растущий `layer4_log` от logger-writes (должен быть >>0 после 1 минуты работы с `LOG_LEVEL=info`).
- [ ] OBS-1 вычеркнут в [docs/02-audit.md](../../02-audit.md).
- [ ] OBS-2 (architectural debt: `channel_message` as msg_type, not role) добавлен как новый open item.

## Deploy note

```bash
ssh root@109.120.187.244
cd /opt/subbrain

# Backup ДО миграции (migration автоматически применится при boot)
docker compose exec subbrain sh -c 'cp /app/data/subbrain.db /app/data/subbrain.db.pre-mig6'

git pull
docker compose build && docker compose up -d
docker compose logs -f | head -50   # смотрим "migration 6 applied"
```

Rollback если что-то пошло не так: migration 6 — CHECK-расширение, ломающим образом не откатывается back через migration-runner; backup восстанавливается вручную из `subbrain.db.pre-mig6`.
