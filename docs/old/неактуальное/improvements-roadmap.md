# Subbrain · Improvements roadmap (post-memory-v2)

**Created:** 2026-04-27 (после M-13 + M-14 deploy, 812/0, mig 16)
**Owner:** guihal
**Status:** Living doc — обновлять при закрытии пунктов.

Прайоритизация по impact/риску. **P0** = закрыть быстро, **P5** = в фоне.

---

## P0 — Operational риск (data loss / blind ops)

### P0-1 — Backup стратегия
**Проблема:** прод DB живёт только в `/data` volume на одном VPS. Disk corruption / `down -v` миском / RAID-fail → история переписки + 4 слоя памяти потеряны навсегда.
**Fix:** cron на прод:
```sh
0 4 * * * sqlite3 /data/subbrain.db ".backup '/backups/subbrain-$(date +\%F).db'" && rsync -az /backups/ user@off-vps:/subbrain-backups/ && find /backups -name '*.db' -mtime +30 -delete
```
**Effort:** 1 час.
**Status:** TODO.

### P0-2 — Observability dashboard
**Проблема:** `metrics_log` таблица существует, никто не смотрит. Не знаем p99 latency / RPM / fallback rate / упали ли провайдеры. Production без dashboard = слепое управление.
**Fix:** Grafana + Prometheus exporter (или простой `/metrics` endpoint в Bun + scrape). Dashboards: requests/min by route + provider, p50/p95/p99 chat latency, model fallback rate, night-cycle duration history, free-agent / freelance findings volume.
**Effort:** 1-2 дня.
**Status:** TODO.

### P0-3 — Staging environment
**Проблема:** каждый rsync — в прод. Нет места протестить deploy перед сдачей.
**Fix:** `docker-compose.staging.yml` на том же VPS на :4001 / поддомене `staging.<domain>`. CI/manual deploy идёт сначала туда. Staging share прод кэш моделей чтобы не платить дважды.
**Effort:** 4-6 часов.
**Status:** TODO.

---

## P1 — Quality / drift detection

### P1-1 — Quantitative eval (LongMemEval / LoCoMo)
**Проблема:** 812 unit tests = correctness кода, но **recall@K на 100k memos неизвестен**. Без чисел улучшения памяти — пшик. Не можем сказать что лучше становится.
**Fix:** запустить LongMemEval baseline → файл `evals/baseline.json`. Каждый релиз — re-run, diff к baseline. PerLTQA + LoCoMo как secondary.
**Effort:** 1 день setup + ongoing 30 min/release.
**Status:** TODO.

### P1-2 — End-to-end integration tests
**Проблема:** M-13 architectural gap (linkRelated не дёргается из MemoryService) **не поймал бы ни один тест в репо** — каждый test correct unit-wise, но runtime-каскад оторван.
**Fix:** `tests/e2e/` — реальный пайплайн user message → chat → hippocampus → memory persisted → edges drawn. Возможно через `fetch` к live test server.
**Effort:** 2-3 дня для базы.
**Status:** TODO.

### P1-3 — Live tests в CI
**Проблема:** `*.live.ts` запускаются вручную. Должен быть еженедельный auto-run против прода на тестовом аккаунте.
**Fix:** GitHub Actions / cron на VPS — раз в неделю `bun run tests/integration.live.ts` против `staging.<domain>`. Push результаты в Telegram alert на падение.
**Effort:** 4 часа.
**Status:** TODO. **Блокировано:** GitHub Actions недоступен (gh blocked). Альтернатива — cron на VPS.

---

## P2 — Memory-specific дыры

### P2-1 — Edge weight = cosine для relates
**Проблема:** M-05 захардкодил `weight = 1.0` (presence, не сила). RAG `score` уже доступен (RRF rank), можно конвертировать в [0..1].
**Fix:** в `link-related.ts` заменить `1.0` на `n.score / max_score`. M-06 reflect / M-09 dedup получат богаче signal.
**Effort:** 5-10 LOC + 2-3 теста. 1 час.
**Status:** TODO. **План:** M-15.

### P2-2 — Auto-supersede на contradiction confidence ≥0.9
**Проблема:** M-05.2 рисует `contradicts` edge, старый факт остаётся `active`. Должен переходить в `superseded` если новый явно противоречит — это semantically корректное поведение.
**Fix:** в `link-related.ts:detectContradictions` block, после draw `contradicts` edge: если `confidence ≥ HARD_CONFIDENCE_THRESHOLD` (default 0.9, env knob) → `memory.updateShared(dst.id, { status: "superseded", superseded_by: insertedId })`.
**Effort:** 20-30 LOC + 4-5 тестов. 3-4 часа.
**Status:** TODO. **План:** M-08.2.

### P2-3 — Embedding cache
**Проблема:** sha256(content) → vec не кэшируется. Re-emb идентичного контента — ноль смысла. Сейчас при night cycle / dedup пересчитываем сотни раз.
**Fix:** новая таблица `embedding_cache(content_sha TEXT PK, vector BLOB, model TEXT, created_at INTEGER)`. RAGPipeline.embedContent сначала смотрит в cache. TTL по `created_at` если меняем embed model.
**Effort:** миграция + 30-50 LOC + тесты. Полдня.
**Status:** TODO.

### P2-4 — Tag canonicalization
**Проблема:** `"ui"` ≠ `"interface"` ≠ `"frontend"` — хранятся как разные tags. Семантический merge нужен на ночнике.
**Fix:** новый night-cycle step `tag-canonicalize`: для каждого tag-кластера в shared/context — LLM call "merge synonyms", пишет mapping в новую таблицу `tag_synonyms(tag, canonical)`. После M-05.1 evolve смотрит mapping.
**Effort:** 1-2 дня (новый step + integration с M-05.1).
**Status:** TODO. **План:** M-16.

### P2-5 — Multi-hop graph queries
**Проблема:** `getRelated(id, layer, depth=1)` поддерживает только 1-hop. Reasoning требует "какие косвенно связанные memos" — depth=2/3 paths.
**Fix:** API `GET /v1/memory/edges/path?from=a&to=b&maxHops=3` + `getRelated(depth=N)` через CTE recursive query в SQLite.
**Effort:** 2-3 дня (SQL + route + UI).
**Status:** TODO. **План:** M-17.

### P2-6 — Bi-temporal model (Zep style)
**Проблема:** только `created_at` и `last_accessed_at`. Не различаем "когда факт был верен" vs "когда мы его узнали". Critical для personal memory: "user жил в Москве 2020-2024, теперь Берлин".
**Fix:** миграция: `valid_from INTEGER`, `valid_until INTEGER NULL` на shared/context. RAG queries фильтруют по `valid_until IS NULL OR valid_until > now`. Auto-supersede проставляет `valid_until` старому факту.
**Effort:** миграция + repository update + RAG query update + UI. 3-5 дней. **Большой.**
**Status:** TODO. **План:** M-15.

### P2-7 — `context-compressor.ts:258` bypass
**Проблема:** overflow-compression пишет в shared через прямой `memory.insertShared` — обходит linkRelated. M-13 не закрыл этот path.
**Fix:** перевести compressor на `memoryService.insertShared(...)` — автоматом получит linkRelated post-hook.
**Effort:** 5-10 LOC. 30 минут.
**Status:** TODO. **Тривиальный fixup.**

### P2-8 — `MemoryTools.writeSharedAtomic` legacy fallback
**Проблема:** legacy fallback в `mcp/tools/memory-tools.ts` тоже обходит linkRelated.
**Fix:** или удалить fallback (всё через service теперь), или вызвать linkRelated явно.
**Effort:** 30-60 минут.
**Status:** TODO. **Опционально** — fallback редко срабатывает.

---

## P3 — Product / UX

### P3-1 — Embedded chat UI
**Проблема:** `/memory` — только админка. Continue.dev + Telegram — единственные surface'ы для real chat. Web UI должен хостить чат напрямую с историей + memory inline.
**Fix:** новая страница `web/app/pages/chat.vue`. SSE stream через прокси `/v1/chat/completions` нашего же сервера. Sidebar = chat list. Вид сообщения = inline citations к memory rows.
**Effort:** 3-5 дней.
**Status:** TODO. **Высокий impact на product feel.**

### P3-2 — Multi-user / real auth
**Проблема:** single token. Если хочешь поделиться — нужны real user accounts + per-user memory partitioning.
**Fix:** users table + JWT auth + agent_id привязан к user_id. Существующая `agent_id` колонка на context/agent_memory готова к этому.
**Effort:** неделя+. **Большая работа** — каждый route + UI.
**Status:** TODO. **Только если будем шарить.**

### P3-3 — Multimodal
**Проблема:** voice / image / file uploads не поддерживаются. Личный AI assistant без multimodal — половина возможностей.
**Fix:** Whisper для voice (cliproxy + OpenAI compat) + image describe через GPT-5 vision. Загруженный файл → парсинг → вписать в memory как regular text.
**Effort:** 3-5 дней per modality.
**Status:** TODO.

### P3-4 — Telegram bot как primary mobile surface
**Проблема:** TG bot есть, но минимально used. Мог быть primary на мобильном — chat там, async query, push от free agent / freelance scout.
**Fix:** расширить `TelegramBot` handlers — `/chat <msg>` → forward в pipeline → reply. Long-form через webhook для голосовых.
**Effort:** 2-3 дня.
**Status:** TODO.

---

## P4 — Agent capability

### P4-1 — Free agent observability
**Проблема:** запускается раз в час, что делает — видно только в TG digest. История в DB не сохраняется.
**Fix:** новая таблица `agent_runs(id, scheduler, started_at, ended_at, steps, final_answer, status)`. UI tab "Agent activity" — таймлайн раз/час с findings.
**Effort:** 1-2 дня.
**Status:** TODO.

### P4-2 — Freelance scout monitoring
**Проблема:** аналогично — leads пишутся в DB но без мета (response time / 429 incidents / category breakdown).
**Fix:** аналогично P4-1 — таблица `scout_runs` + UI dashboard.
**Effort:** 1 день.
**Status:** TODO.

### P4-3 — Free agent loop quality knobs
**Проблема:** включён 2026-04-27, мониторим. После недели observation выяснится: too noisy / too quiet / wrong topics.
**Fix:** `FREE_AGENT_INTERVAL_MIN`, `FREE_AGENT_MAX_STEPS`, `FREE_AGENT_TASK` (custom prompt) — knobs готовы. Tune по результату.
**Effort:** ongoing. Через неделю — first review.
**Status:** **MONITORING** (2026-04-27 → 2026-05-04).

---

## P5 — Internal process

### P5-1 — System architecture diagram
**Проблема:** `AGENTS.md` 21K текста — нечитаемо за раз. Нужна визуальная карта потоков.
**Fix:** Mermaid diagram'ы в `AGENTS.md`:
- Request flow (chat path → pipeline phases → providers).
- Memory flow (4 layers + writers + readers).
- Night-cycle steps (sequential phases).
- Edge graph (kinds + cascading post-hooks).
**Effort:** 4-6 часов.
**Status:** TODO. **Direct help для re-onboarding'а.**

### P5-2 — Cost tracking
**Проблема:** Copilot / NVIDIA / OpenRouter / cliproxy gpt-5.1 — где сколько съели? Не знаем.
**Fix:** `metrics_log` aggregator + new column `cost_estimate_usd` на каждый upstream call (token count × price-per-token). UI — daily / weekly / monthly breakdown по провайдеру.
**Effort:** 1-2 дня.
**Status:** TODO.

### P5-3 — Owner re-onboarding ritual
**Проблема:** owner признал слабый контроль продукта (project memory `project_owner_context_gap.md`).
**Fix:** раз в неделю 1-час сессия "explain me X subsystem from scratch" — закроет gap планомерно. Скилл `claude-code-guide` / `general-purpose` agent читает subsystem doc + код, объясняет как onboarding.
**Effort:** 1 час/неделю ongoing.
**Status:** ONGOING. **Cadence:** еженедельно. **Owned by owner.**

### P5-4 — `metrics_log` audit
**Проблема:** таблица существует, но что туда пишется и зачем — не очевидно. Может быть мёртвый код.
**Fix:** прочитать все `INSERT INTO metrics_log` callsite'ы, понять — нужна / удалить / расширить.
**Effort:** 1-2 часа.
**Status:** TODO. **Низкий приоритет — но cleanup'ный.**

---

## Done в этой сессии (2026-04-27)

- [x] M-11 — sleep-time focus rewrite (mig 16, shadow-write, env-gated)
- [x] M-05.1 — A-MEM tag evolution на linkRelated
- [x] M-05.2 — LLM contradiction detection (default OFF)
- [x] M-13 — close MemoryService → linkRelated gap (post-hook wiring)
- [x] M-14 — admin REST + UI surface для memory_edges
- [x] **Free agent enabled в проде** (2026-04-27 18:40 UTC, every 60 min)

---

## Recommended sequencing (если бы выбирал сам)

**Эта неделя (high-leverage / низкий effort):**
1. P0-1 backup (1 час, защита от data loss)
2. P2-1 edge weight = cosine (1 час, max impact на quality)
3. P2-7 compressor bypass fix (30 минут, закрывает hole)
4. P5-1 architecture Mermaid (4 часа, помогает re-onboarding)

**Через 2 недели:**
5. P1-1 LongMemEval baseline (день → есть число)
6. P2-2 auto-supersede M-08.2 (полдня)
7. P3-1 embedded chat UI (3-5 дней → реальный продукт, не админка)

**Месяц+ / большая работа:**
8. P2-6 bi-temporal модель M-15 (3-5 дней + миграция)
9. P3-2 multi-user (неделя+, only если шарить)

---

## Поддерживать этот файл

Закрыли пункт → `[x]` в Done секции + удалить из P-секции. Появился новый риск / запрос — добавить под нужным P-tier'ом с **Status: TODO**. Last update в headere.
