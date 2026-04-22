# Phase 4 — TG reliability (CAS-lock + supervisor + upsertBySource для unread DMs)

**Complexity:** complex. **Estimate:** 1 day.
**Depends on:** Phase 1 (tasks/scheduler_state tables, upsertBySource ready), Phase 2 (renderTgStatus читает scheduler_state), Phase 3 (рекомендуется — rate-limit защитит от TG-burst).
**Trigger:** `/task --depth=complex <весь этот файл как prompt>`.

## Цель

TG-поллер сейчас нестабилен: агент говорит "я проверил TG" но галлюцинирует содержимое. Решение: poller записывает непрочитанные DMs как `tasks` (scope="tg") через идемпотентный `upsertTaskBySource`. Агент видит их в промпте через уже существующий [renderTgStatus](../../../src/pipeline/agent-loop/prompt-blocks/tasks.ts) и `Active tasks` блок. Ответил → `task_done`. Сообщение удалилось → `ToolError{tg_gone}` → агент сам `task_cancel`.

Также: single-statement CAS-lock (`tryAcquireLock` уже написан в Phase 1, нужно подключить) + supervisor с exponential backoff + `AbortController` для graceful shutdown race.

## Контекст

**Существующий TG-поллер:** поискать `src/scheduler/telegram-poller.ts` или аналог в `src/scheduler/`, `src/telegram/`. Если нет — **это означает что TG-чек сейчас делается ad-hoc через MCP tools** (`tg_list_chats`, `tg_read_chat`). Тогда задача расширяется: создать scheduler с нуля. Grep `grep -rn "telegram-poller\|TelegramPoller" src/` чтобы понять состояние.

**Phase 1 предоставил:**
- `memory.upsertTaskBySource(source, fields, newId)` — idempotent.
- `memory.tryAcquireSchedulerLock(key, myId, staleSec)` — single-statement CAS.
- `memory.heartbeatSchedulerLock(key, myId)` — returns false если lock потерян.
- `memory.upsertSchedulerState(key, value)`.

**Phase 2 предоставил:**
- `renderTgStatus(memory)` читает `scheduler_state["tg.last_checked_at"]` и `countTasksActive("tg")` — показывает агенту в промпте.

## Scope

### 1. TG-поллер: source key + idempotent upsert

**File:** `src/scheduler/telegram-poller.ts` (modify existing или new ≤250 lines).

Для каждого unread message через MTProto:
```ts
const source = `tg:peer=${msg.peer_id}:msg=${msg.msg_id}`;
memory.upsertTaskBySource(
  source,
  {
    scope: "tg",
    title: preview(msg.text, 80),
    description: `От @${msg.from_handle} (${new Date(msg.ts*1000).toISOString()}):\n${msg.text}`,
    priority: senderPriority(msg.from_handle),  // if-known-contact → higher
  },
  randomUUID(),
);
```

**Ключевое:** source содержит `peer_id` (не только msg_id) — msg_id уникален только в рамках одного peer, без peer_id коллизии между разными DMs затирают задачу.

**Edit семантика:** MTProto edit сохраняет msg_id → upsertBySource обновит title/description если задача active. Terminal task (уже ответили) → `skipped=true`, не трогаем.

**Delete семантика:** MTProto delete не callback'ится в poll. Агент попытается ответить → `tg_reply` tool возвращает `ToolError{code:"tg_gone"}` → агент видит hint в промпте (Phase 2 уже рендерит) → вызывает `task_cancel({id, reason:"tg: source deleted"})`. Нет hidden mutations.

### 2. CAS-lock + heartbeat

```ts
const LOCK_KEY = "tg.poller.lock";
const LOCK_STALE_SEC = 600;
const LOCK_HEARTBEAT_SEC = 30;
const myId = `${process.pid}-${Date.now()}`;

async function tryAcquire(): Promise<boolean> {
  return memory.tryAcquireSchedulerLock(LOCK_KEY, myId, LOCK_STALE_SEC);
}

function heartbeat(): boolean {
  return memory.heartbeatSchedulerLock(LOCK_KEY, myId);
}
```

### 3. Supervisor с exponential backoff

```ts
let backoffMs = 30_000;
while (!app.shuttingDown) {
  if (!(await tryAcquire())) {
    await sleep(backoffMs + jitter(0.2 * backoffMs));
    backoffMs = Math.min(backoffMs * 2, 300_000);
    continue;
  }
  backoffMs = 30_000;
  const startedAt = Date.now();
  await runPoller(myId);  // exits when heartbeat loses
  if (Date.now() - startedAt > 10 * 60_000) backoffMs = 30_000;
}
```

Исключает ping-pong: если две instance conflict'ят — первая hold'ит 10+ min без потери lock → вторая exponentially backing off до 5 min между попытками.

### 4. AbortController для shutdown race

```ts
let shutdownRequested = false;
let currentPollAbort: AbortController | null = null;
const hbTimer = setInterval(() => {
  if (shutdownRequested) return;
  if (!heartbeat()) {
    shutdownRequested = true;
    log.warn(`Lost lock (myId=${myId}), shutting down`);
    currentPollAbort?.abort();
    clearInterval(hbTimer);
  }
}, LOCK_HEARTBEAT_SEC * 1000);

async function tick() {
  if (shutdownRequested) return;
  currentPollAbort = new AbortController();
  try {
    await pollUnreadDMs({ signal: currentPollAbort.signal });
    memory.upsertSchedulerState(
      "tg.last_checked_at",
      String(Math.floor(Date.now() / 1000)),
    );
  } catch (e) {
    if (currentPollAbort.signal.aborted) return;
    log.error(`poll failed: ${String(e)}`);
  } finally {
    currentPollAbort = null;
  }
}
```

`upsertTaskBySource` idempotent → partial writes при abort безопасны (следующий инстанс perepишет).

### 5. Wire в bootstrap

`src/app/bootstrap.ts` или `src/app/schedulers.ts` — если `TELEGRAM_POLLER_ENABLED === "true"` (env flag, default "false"), запустить supervisor в background. Shutdown handler ждёт `shutdownRequested=true; currentPollAbort?.abort(); await pollerPromise`.

### 6. Tests

**File:** `tests/telegram-poller.test.ts`:
- `tryAcquireLock` базовый: новый key → true; второй вызов того же myId → true (heartbeat); второй разный myId до stale → false; после stale → true.
- Heartbeat: после acquire heartbeat возвращает true; после перехвата другим myId heartbeat возвращает false.
- Mock MTProto + 5 unread messages → `upsertTaskBySource` вызывается 5 раз с уникальными source keys.
- Duplicate poll: те же 5 messages → 5 `skipped=false created=false` (или `created=true` на новой — проверить semantics); важно — в DB остаётся 5 rows, не 10.
- Edit: second poll с изменённым текстом одного msg_id → title/description обновлён в соответствующей task.
- `task_done` на одной из tg-tasks → последующий poll с тем же msg_id → `skipped=true`, title НЕ возвращается к original.
- Last-checked-at: после poll `scheduler_state["tg.last_checked_at"]` = current unix seconds.

**Mock подход:** не тестировать реальный MTProto. Создать `interface MTProtoClient { listUnreadDMs(): Promise<Msg[]> }`, передавать mock в `TelegramPoller` constructor. Unit-тесты на логику upsert+status update без сети.

### 7. Docs

`docs/completed/telegram-poller.md` (new или update) — описать CAS + supervisor + AbortController design. Ссылаться на `docs/tasks/task-store/04-tg-reliability.md`.

## Edge cases

- Poll время превышает heartbeat interval → heartbeat fires внутри tick → если lock всё ещё наш, продолжаем; если потеряли (clock skew), abort срабатывает в течение <30s.
- `peer_id` = 0 или negative (channel vs DM) → валидация в TG-tool wrapper, сомнительный message пропустить.
- `title=""` из пустого сообщения (фото без caption) → `preview("", 80) = ""` → title пустой → upsert вставит; UI/prompt покажет `- 📌 [id] ` без названия. Acceptable, но лучше fallback `title="[photo]"` / `[voice]`.
- `priority` из `senderPriority(handle)` — как определяется? Если неизвестный handle → 0. Known contact из shared_memory → 3. Prioritized list (whitelist env TG_PRIORITY_HANDLES) → 5.
- Shutdown during poll: abort signal проверяется после каждого upsert? bun:sqlite операции синхронные, abort только между awaits. Acceptable.
- App restart: сохранённые unread в DB остаются, next boot poller читает их заново через upsert (idempotent, skipped=false-created=false потому что уже есть).

## Verify

```bash
bunx tsc --noEmit     # exit 0
bun test tests/telegram-poller.test.ts
bun test              # full regression
```

**Manual smoke (optional):** запустить dev server с `TELEGRAM_POLLER_ENABLED=true` и реальным MTProto session, один unread DM → `curl /v1/tasks?scope=tg` покажет задачу.

## Out of scope

- Sending (tg_reply тулы уже есть, modify для `tg_gone` error code если нет — мелкая правка).
- Retention (tg-tasks после `done` через 7 дней уходят в digest — Phase 5).
- UI для tg-tasks (Phase 6 покажет во общей `/tasks` странице по scope filter).

## Guardrails reminder

- `src/scheduler/telegram-poller.ts` ≤ 250 lines.
- `logger.child("tg.poller").info("stage","message")` — двухаргументный у root, одноаргументный у child. Проверь что не путаешь.
- MTProto calls — через `fetchJson`/`fetchStream` если HTTP, или через существующий MTProto wrapper.
- Shutdown: signal composing через `AbortSignal.any([externalSignal, currentPollAbort.signal])`.
- Tests: bun:test, не top-level `process.exit`.

## Что изменяется в git

Новые: `src/scheduler/telegram-poller.ts` (или modified если существует), `tests/telegram-poller.test.ts`, опционально `docs/completed/telegram-poller.md`.
Modified: `src/app/bootstrap.ts` (или `schedulers.ts`), `.env.example` (+`TELEGRAM_POLLER_ENABLED`, `TG_PRIORITY_HANDLES`), MTProto tools если меняется error code для `tg_gone`.
