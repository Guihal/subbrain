# Задача 18 — `tg_send_message` честно падает (TG-1)

**Оценка:** 2 часа
**Зависимости:** —
**Status:** DONE (PR #18)

## Цель

Агент может думать «я уведомил владельца», хотя Telegram Bot API вернул ошибку.

Цепочка сейчас:

1. [src/telegram/bot.ts:238-247](../../../src/telegram/bot.ts#L238-L247) — `notify()` ловит err, пишет в лог, резолвится `void`.
2. [src/app/deps.ts:373](../../../src/app/deps.ts#L373) — `setBotNotify((t) => bot.notify(t))`.
3. [src/mcp/executor.ts:76-87](../../../src/mcp/executor.ts#L76-L87) — `tgSendMessage()` `await this.botNotify(text)` никогда не бросает → `return { success: true }`.
4. Registry tool `tg_send_message` видит `{ success: true }` → модель считает доставку успешной.

## Файлы

- [src/telegram/bot.ts](../../../src/telegram/bot.ts) — добавить `notifyOrThrow(text)`.
- [src/app/deps.ts](../../../src/app/deps.ts) — привязать `setBotNotify` к `notifyOrThrow`.
- [src/mcp/executor.ts](../../../src/mcp/executor.ts) — корректно обернуть throwing `botNotify`.
- [src/mcp/registry/telegram.tools.ts](../../../src/mcp/registry/telegram.tools.ts) — handler `tg_send_message` конвертирует throw в `ToolResult { ok: false, error: { code: "tg_delivery_failed", message } }`.

## Изменение

1. `TelegramBot.notifyOrThrow(text)` — прямая обёртка над `bot.api.sendMessage(ownerChatId, text, { parse_mode: "Markdown" })`, без `try/catch`.
2. `TelegramBot.notify(text)` — **оставить** как есть. Используется для fire-and-forget (digests, alerts в `notifyDigest` / `notifyAutonomous`), где исключение поверх текущей задачи нежелательно.
3. `deps.ts`: `setBotNotify((t) => bot.notifyOrThrow(t))` — теперь executor получает версию, которая падает.
4. `executor.tgSendMessage()`:
   - `await this.botNotify(text)` остаётся в `try`, но ловит настоящую ошибку.
   - `catch (err)` → `return { success: false, error: err.message }`.
5. `registry/telegram.tools.ts` — handler:
   - `const r = await ctx.executor.tgSendMessage(args.text)`.
   - `r.success === false` → `return { ok: false, error: { code: "tg_delivery_failed", message: r.error } }`.
   - `r.success === true` → `return { ok: true, data: r.data }`.

Tool-runner сериализует `ToolResult` в строку, агент видит честный error и может повторить/сменить канал.

## Тесты

`tests/telegram-notify.test.ts`:

- Unit: mock `bot.api.sendMessage` → throw `Error("telegram 500")`. `notifyOrThrow` бросает. `notify` — не бросает, лог есть.
- Unit `executor.tgSendMessage` с `botNotify` throwing → `{ success: false, error: "telegram 500" }`.

`tests/tg-send-tool.test.ts`:

- Integration: stub executor с throwing `botNotify`. Handler `tg_send_message` возвращает `{ ok: false, error: { code: "tg_delivery_failed" } }`.
- Контракт: при success возвращается `{ ok: true }` неизменно.

## Приёмка

- [x] `bunx tsc --noEmit` = 0.
- [x] Новые тесты зелёные (`tests/telegram-notify.test.ts`, `tests/tg-send-tool.test.ts`, 10/10 pass).
- [x] `grep -n 'this.botNotify(text)' src/mcp/executor.ts` показывает корректный `try/catch` (не пустой).
- [x] `grep -n 'bot.notify(text)' src/app/deps.ts` заменён на `bot.notifyOrThrow(text)`.
- [x] TG-1 вычеркнут в [docs/02-audit.md](../../02-audit.md).

## Реализация — отличия от первоначального плана

Тип `ToolResult` в репо — `{ success, data?, error?: string }` (не `{ ok, error: {code, message} }`
из общих guardrail-заметок). Менять форму `ToolResult` для одного тула не решились —
это затронуло бы `tool-runner.ts`, MCP-протокол и все 30+ хендлеров. Вместо этого handler
`tg_send_message` при ошибке возвращает `{ success: false, error: "tg_delivery_failed: <msg>" }`:
код-префикс даёт агенту машинно-различимый сигнал, а полная миграция на `{code, message}`
(когда будет PR на всю систему) просто поменяет формат этой строки на объект — публичный
контракт handler-а уже шлёт honest failure.

## Deploy note

```bash
ssh root@109.120.187.244
cd /opt/subbrain
git pull
docker compose build && docker compose up -d
```
