# docs/tasks/refactor

Таск-файлы для рефакторинга subbrain по мастер-плану [docs/01-refactor-plan.md](../../01-refactor-plan.md).

Каждый файл = один PR. Содержит самодостаточный минимум контекста: что болит, что меняем, какие тесты, какие файлы трогаем, в каком порядке, критерии приёмки.

## Список

| # | Задача | Оценка | Зависимости |
|---|---|---|---|
| [01](01-pipeline-robustness.md) | Pipeline robustness: HIGH-2/3/5/6 (arbitration allSettled, tool timeouts, FTS sanitize тегов, night-cycle transaction) | 1 день | — |
| [02](02-hardening-race-cap-n1-sse.md) | Hardening: HIGH-1/4/7/9 (rate-limiter mutex, fallback cap, RAG N+1, SSE write-after-close) | 1 день | после 01 |
| [03](03-http-client-unification.md) | HIGH-8: единый `lib/http-client.ts` + тесты с compose'нными сигналами | 1 день | — |
| [04](04-auth-timing.md) | HIGH-10: timing-safe token compare | 0.5 часа | — |
| [05](05-medium-pack.md) | MEDIUM pack: MED-1..MED-14 одним PR | 1 день | — |
| [06](06-browser-playwright-direct.md) | BROWSER-1: апдейт `@playwright/mcp` → fallback на прямой `chromium.launch` + leak-smoke | 1–1.5 дня | — |
| [07](07-split-index-to-app.md) | Splitting `src/index.ts` (440) → `src/app/*` | 0.5 дня | — |
| [08](08-split-agent-loop.md) | Splitting `src/pipeline/agent-loop/index.ts` (625) | 1 день | после 01, 02 |
| [09](09-split-agent-pipeline.md) | Splitting `src/pipeline/agent-pipeline/*` (pre/post/main phases) | 1 день | — |
| [10](10-split-db-tables.md) | Splitting `src/db/index.ts` (716) → `db/tables/*` | 0.5 дня | — |
| [11](11-split-memory-page.md) | Splitting `web/app/pages/memory.vue` (651) + `useMemory.ts` (440) | 1 день | — |
| [12](12-split-use-chat.md) | Splitting `web/app/composables/useChat.ts` (430) | 0.5 дня | — |
| [13](13-app-error-logger-envelope.md) | AppError + `logger.child` + `PaginatedResponse` | 0.5 дня | после 10 |
| [14](14-sse-parser-providers.md) | Вынос `providers/sse-parser.ts` (copilot + nvidia reuse) | 0.5 дня | — |
| [15](15-tests-docs-acceptance.md) | Тесты (smoke MCP registry, memory admin, compressor, …) + обновление доков | 1 день | после всех |

Суммарно ~10–11 дней в одну руку. Большинство PR независимы — распараллеливается.

## Граф зависимостей

```
01 ──┬─► 02 ──► 08
     └───────────┘
10 ──► 13
все ──► 15
06, 03, 04, 05, 07, 09, 11, 12, 14 — независимы
```

## Порядок для одного исполнителя

1. **День 1:** PR 01 (pipeline robustness).
2. **День 2:** PR 02 + PR 04 (0.5ч) — ловят высокие риски.
3. **День 3:** PR 03 (http-client).
4. **День 4:** PR 05 (MEDIUM pack) + PR 07 (split index).
5. **День 5:** PR 08 (split agent-loop).
6. **День 6:** PR 09 (split agent-pipeline) + PR 10 (split db).
7. **День 7:** PR 11 (split memory UI).
8. **День 8:** PR 12 (split useChat) + PR 13 (AppError/logger/envelope).
9. **День 9:** PR 14 (sse-parser) + PR 06 day1 (browser A).
10. **День 10:** PR 06 day2 (browser B + leak-smoke).
11. **День 11:** PR 15 (tests + docs).

## Правила закрытия таска

При мёрдже PR, соответствующего файлу `NN-*.md`:

1. ✅ в [docs/02-audit.md](../../02-audit.md) по закрытым HIGH/MED пунктам со ссылкой на PR.
2. Вычеркнуть строку из таблицы в [docs/01-refactor-plan.md](../../01-refactor-plan.md).
3. В этом файле (`refactor/NN-*.md`) пометить `Status: DONE (PR #N)` в шапке.
4. Если изменилась структура директорий — синхронизировать [CLAUDE.md](../../../CLAUDE.md) (пути, описание подсистем).

## Что намеренно не трогаем

Из секции «Что намеренно не трогаем» мастер-плана:

- [src/pipeline/agent-loop/system-prompt.ts](../../../src/pipeline/agent-loop/system-prompt.ts) — цельный промпт.
- [src/lib/model-map.ts](../../../src/lib/model-map.ts) — маленький и корректный.
- [src/rag/pipeline.ts](../../../src/rag/pipeline.ts) — только точечные MED-правки.
- MCP registry (`src/mcp/registry/*`) — уже разделён.
- Telegram-модули — специфичная MTProto/Bot API логика, splitting без пользы.
