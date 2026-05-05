# Задача 43 — PR-D: Hippocampus rewrite (post-extractor focused writes)

**Оценка:** 2-3 часа
**Зависимости:** PR-A merged (`ea3e910`)
**Status:** PENDING
**Spec ref:** [docs/superpowers/specs/2026-05-03-memory-hygiene-and-agent-usefulness.md § PR-D](../../superpowers/specs/2026-05-03-memory-hygiene-and-agent-usefulness.md)

## Цель

Post-pipeline extractor пишет фокусно: 0-3 факта на exchange, не «всё подряд». Бьёт R2 (free-agent дампит 2000-char markdown в context) на ingestion-side.

Этот PR независим от PR-B/C — после PR-A whitelist enforcement можно мержить параллельно.

## Контракт исполнителя

Эта задача — **prompt rewrite + hard cap + telemetry hook + tests update**. Pure logic + textual swap. Никакой schema-changes, никакого pool, никакого teamlead synthesis.

**Allowed actions:**
- Edit `packages/agent/src/pipeline/agent-pipeline/post/prompt.ts` — rewrite `getExtractorPrompt()` body. Только текст; signature остаётся.
- Edit `packages/agent/src/pipeline/agent-pipeline/post/hippocampus.ts` — добавить `MAX_WRITES_PER_EXCHANGE=3` const + counter + cap-check; telemetry log entries.
- Edit `tests/hippocampus-extraction.test.ts` — обновить expectations под новый prompt и cap.
- Создать `tests/hippocampus-cap.test.ts` — purely cap behavior test.
- Edit `packages/core/src/lib/metrics.ts` если файл существует — добавить counter. Если не существует — НЕ создавать, использовать `logger.info` calls (см. §3).
- `bunx tsc --noEmit`, `bun test`, `bun run scripts/check-file-size.ts`.
- `git commit -m "feat(hippocampus): focused writes (≤3 per exchange) + supersede-aware (PR-D)"`.

**Hard NO-GO:**
- НЕ менять `MAX_HIPPO_STEPS=5` (это другая метрика).
- НЕ менять signature `getExtractorPrompt`, `runHippocampus`, или `MIN_EXTRACTION_LENGTH`.
- НЕ trogать `packages/agent/src/pipeline/agent-pipeline/post/extractors.ts`, `gate.ts` (они out-of-scope).
- НЕ менять `WHITELIST_*` из PR-A (это уже merged, contractual).
- НЕ trogать pool/runners/teamlead/arbitration (PR-C/E территория).
- НЕ создавать новый MCP tool / новый layer / новую таблицу.
- НЕ менять `memory_search` cosine threshold для других callers — только в hippocampus prompt.
- НЕ trogать `packages/agent/src/pipeline/arbitration/prompts.ts` (PR-E).
- НЕ `git push`, НЕ `gh`, НЕ `--no-verify`.
- НЕ запускать prod / docker / ssh — deploy не часть задачи.
- В новом prompt'е НЕ писать «save tokens» / «be efficient» / «не пиши слишком много» (anti-economy, лимит даётся через rule #1, не через лозунг).

**Diff boundary:** ровно эти файлы:
```
packages/agent/src/pipeline/agent-pipeline/post/hippocampus.ts
packages/agent/src/pipeline/agent-pipeline/post/prompt.ts
packages/core/src/lib/metrics.ts                                    # ТОЛЬКО если файл уже существует
tests/hippocampus-extraction.test.ts
tests/hippocampus-cap.test.ts
```
Любой extra (особенно в `extractors.ts`, `gate.ts`, runners, schema) = STOP, FAIL.

**Output contract:** `OK <sha7> feat(hippocampus): focused writes (≤3 per exchange) + supersede-aware (PR-D)` или `FAIL: <reason>`.

## Файлы

- [packages/agent/src/pipeline/agent-pipeline/post/prompt.ts](../../../packages/agent/src/pipeline/agent-pipeline/post/prompt.ts) — пересобрать `getExtractorPrompt` (текстовый swap; никаких behavior-changes в коде кроме prompt).
- [packages/agent/src/pipeline/agent-pipeline/post/hippocampus.ts](../../../packages/agent/src/pipeline/agent-pipeline/post/hippocampus.ts) — добавить hard cap `MAX_WRITES_PER_EXCHANGE=3` (было `MAX_HIPPO_STEPS=5`, оставить — это другая метрика). После 3-го успешного write — `done` принудительно.
- [tests/hippocampus-extraction.test.ts](../../../tests/hippocampus-extraction.test.ts) — обновить ожидания.

## Изменение

### 1. `getExtractorPrompt` (новый текст)

```
Ты — гиппокамп этого юзера. Записываешь только то, что surprising / non-obvious / actionable. Скучные факты не сохраняются — забываются.

ПРАВИЛА:
1. Cap: ≤3 `memory_write` на exchange. Если уверен только в 2 — пиши 2. Если 0 — это ОК, всегда лучше не писать чем написать мусор.

2. Pre-write thinking step (REQUIRED перед каждым write):
   - Сформулируй candidate-fact одним предложением.
   - Вызови `memory_search(query=candidate-fact, layer=shared OR context, top_k=3)`.
   - Если cosine ≥0.92 к existing row → ПРОПУСТИ, ничего не пиши (это duplicate).
   - Если cosine 0.85-0.92 → пиши с `supersedes_id: <existing_id>` (обновление, не дубль).
   - Если cosine <0.85 → fresh insert.

3. WHITELIST categories (PR-A enforced; см. validators.ts):
   - shared: profile, preference, skill, goal, relationship, style, constraint, decision, learning
   - context: project, bug, decision, architecture, learning
   - Если ни одна категория не подходит — НЕ пиши, сообщи `done`.

4. DO-NOT-SAVE list (мусор, который агенты любят писать):
   - temporary state ("сейчас обсуждаем X", "в данный момент Y")
   - in-progress task IDs / tool execution timestamps / debug logs
   - rephrased версии того что юзер сам только что сказал в этом exchange
   - factual lookups которые легко повторить (даты релизов библиотек, weather, score спортивных событий)
   - chat-flow markers ("я сказал X, юзер ответил Y")

5. БАЛАНС: каждое 3-е сообщение юзера содержит хотя бы один artefact-worthy факт. Если ты пропустил 3 exchanges подряд — ты слишком осторожен; следующий значимый факт пиши с уверенностью.

ACTIONABLE = «эта инфа понадобится в другой сессии / другому агенту / через месяц». Если нет — не пиши.
```

### 2. Hard cap в `hippocampus.ts`

```ts
const MAX_WRITES_PER_EXCHANGE = 3;
let writesCount = 0;

// в loop'е, при tool_call === "memory_write":
if (writesCount >= MAX_WRITES_PER_EXCHANGE) {
  // Принудительно ответ tool_result с warning, и через 1 step force `done`
  toolResult = {ok: false, error: {code: "limit_exceeded", message: "max 3 writes per exchange"}};
} else if (toolResult.ok) {
  writesCount++;
}
```

`MAX_HIPPO_STEPS = 5` оставить (это шаги loop'а, не writes — может быть несколько search'ей перед одним write).

### 3. Telemetry counter (для acceptance)

Добавить в [packages/core/src/lib/metrics.ts](../../../packages/core/src/lib/metrics.ts) если есть, иначе log:
- `hippocampus_writes_per_exchange` — histogram (в runtime — log entry с `{exchange_id, writes_count, skipped_dup_count}`).
- При `cosine ≥0.92` skip → `logger.info("hippocampus", "skip_dup", {cosine, candidate_first_50})`.
- При `cosine 0.85-0.92` supersede → `logger.info("hippocampus", "supersede", {old_id, new_content_first_50})`.

## Тесты

Обновить `tests/hippocampus-extraction.test.ts`:

- Stub LLM возвращает 5 tool_calls `memory_write` подряд → только первые 3 пройдут, 4-й и 5-й получают `limit_exceeded` ответ.
- Stub `memory_search` возвращает existing row с cosine 0.95 → следующий `memory_write` candidate с тем же query → loop НЕ должен совершить write (skip-dup; telemetry log entry).
- Stub `memory_search` возвращает row с cosine 0.88 → write проходит с `supersedes_id`.
- Empty extraction (LLM сразу `done`) → 0 writes, no error.
- DO-NOT-SAVE category (попытка `memory_write {category:"temporary-state"}`) → блокируется PR-A validator (`validation_failed`).

`tests/hippocampus-cap.test.ts`:
- `MAX_WRITES_PER_EXCHANGE=3` constant.
- 6-tool-call sequence (3 writes + 3 searches) → 3 writes succeed, no cap-block.

## Premortem

| # | Симптом | Mitigation | Recovery |
|---|---------|------------|----------|
| 1 | Hippocampus стал слишком осторожным → 0 writes за неделю | Rule #5 («каждое 3-е сообщение») + prompt балансировка через ACTIONABLE definition. | Telemetry alert на `writes_count==0` 5 exchanges подряд → manual prompt revision в follow-up PR. A/B liberal fallback НЕ в scope этого PR (см. spec FM-7). |
| 2 | Cosine threshold 0.92 слишком строгий для русского текста → false-positive duplicates | Не tune per-language в этом PR. Telemetry `skip_dup` count наблюдаем. | Если skip_dup rate >40% от candidate-writes в night-janitor — env `HIPPO_DUP_THRESHOLD=0.88` follow-up. |
| 3 | `MAX_WRITES_PER_EXCHANGE` counter race при concurrent steps | Loop в hippocampus single-threaded (sequential step execution в agent loop) — race не возможна by design. Counter — обычная local var. | НЕ применяется. Если кто-то распараллелит hippocampus loop — это поломка контракта, fix отдельным PR. |
| 4 | Supersede-aware logic пишет в `supersedes_id` несуществующий id (race с deletion) | `memory_search` возвращает live row из db; между search и write — single hippocampus step (sequential). Window race теоретически есть, но FK не enforced на supersedes_id (nullable hint, не constraint). | Если найдём dangling supersedes_id rows в night-janitor → janitor чистит. Не блокер этого PR. |
| 5 | Telemetry log entries ломают log parser (новый formatter контракт) | Использовать `logger.info(stage, message, extra?)` 3-arg arity (см. CLAUDE.md guardrail #9). `extra` — plain object, JSON.stringify-able. | Если log meta corrupt — `logger.formatForDb` fallback. tsc + `bun test` ловит arity bug при ручной проверке. |
| 6 | Новый prompt collision с PR-A whitelist validator (категория не в whitelist) | Rule #3 в prompt'е явно перечисляет whitelist categories (shared/context). Prompt инструктирует «если ни одна не подходит → не пиши, done». | Если LLM всё равно пишет non-whitelist → PR-A validator блокирует write с `validation_failed`. Hippocampus loop получает error в tool_result, переходит к следующему step / done. Test #5 в § Тесты явно проверяет. |
| 7 | Файл-кап 150 строк сломан после добавления counter + telemetry в hippocampus.ts | Перед commit'ом проверить `wc -l packages/agent/src/pipeline/agent-pipeline/post/hippocampus.ts ≤150`. Если близко к лимиту — extract counter+cap-check helper в `post/cap-guard.ts` (но это уже expansion scope — proceed с осторожностью). | Если split неизбежен — добавить новый файл в diff boundary explicitly, обновить план. Не игнорировать file-cap. |
| 8 | Anti-economy violation в новом prompt'е («save tokens» / «не пиши слишком много» / «постарайся уложиться») | Hard NO-GO в § Контракт. Self-check: `grep -niE 'save token\|be efficient\|постарайся уложиться\|не пиши слишком много\|не используй tool без нужды' packages/agent/src/pipeline/agent-pipeline/post/prompt.ts → 0 matches`. | Если grep matches — переписать prompt rule, лимит передаётся через rule #1 (cap=3), не лозунгами. |
| 9 | Existing tests падают на новом prompt тексте (assertion на старые фразы) | `tests/hippocampus-extraction.test.ts` обновляется в этом PR — assertions перепиваются под новый prompt. Stub LLM возвращает фиксированные tool_calls, prompt content не assert'ится дословно. | Если test фейлит на assertion `expect(prompt).toContain('старая фраза')` — заменить на новые phrases (surprising/non-obvious/actionable). |

## Приёмка

Каждый пункт — bash команда + ожидаемый output. Прогнать ВСЕ перед commit'ом.

```bash
# 1. TypeScript clean
bunx tsc --noEmit
# expect: exit 0, no output

# 2. Touched test files pass
bun test tests/hippocampus-extraction.test.ts tests/hippocampus-cap.test.ts
# expect: all pass, "0 fail"

# 3. Full suite no regression
bun test 2>&1 | tail -3
# expect: "0 fail" в финальной строке

# 4. File caps
bun run scripts/check-file-size.ts
# expect: exit 0, "all files under cap"
wc -l packages/agent/src/pipeline/agent-pipeline/post/hippocampus.ts packages/agent/src/pipeline/agent-pipeline/post/prompt.ts
# expect: оба ≤150

# 5. MAX_WRITES_PER_EXCHANGE constant added
grep -nE 'MAX_WRITES_PER_EXCHANGE\s*=\s*3' packages/agent/src/pipeline/agent-pipeline/post/hippocampus.ts
# expect: ≥1 match

# 6. New prompt phrases active (Russian + English keywords)
grep -nE 'surprising|non-obvious|actionable' packages/agent/src/pipeline/agent-pipeline/post/prompt.ts
# expect: ≥3 matches (фразы из rule headers)
grep -cE 'memory_search.*candidate' packages/agent/src/pipeline/agent-pipeline/post/prompt.ts
# expect: ≥1 (rule #2 pre-write thinking step)

# 7. Cap behavior — limit_exceeded path
grep -nE 'limit_exceeded' packages/agent/src/pipeline/agent-pipeline/post/hippocampus.ts
# expect: ≥1 match (tool_result error code)

# 8. Anti-economy guard — НЕ должно быть в новом prompt'е
grep -niE 'save token|be efficient|постарайся уложиться|не пиши слишком много|не используй tool без нужды' packages/agent/src/pipeline/agent-pipeline/post/prompt.ts
# expect: 0 matches (HARD FAIL если хоть один)

# 9. MAX_HIPPO_STEPS не тронут
grep -nE 'MAX_HIPPO_STEPS\s*=\s*5' packages/agent/src/pipeline/agent-pipeline/post/hippocampus.ts
# expect: ≥1 match (constant сохраняется как было)

# 10. Signature `getExtractorPrompt` сохранён
grep -nE 'export function getExtractorPrompt\b' packages/agent/src/pipeline/agent-pipeline/post/prompt.ts
# expect: ≥1 match — signature не менялась

# 11. Diff boundary — только разрешённые файлы
git diff --name-only HEAD
# expect: ровно subset of {
#   packages/agent/src/pipeline/agent-pipeline/post/hippocampus.ts,
#   packages/agent/src/pipeline/agent-pipeline/post/prompt.ts,
#   packages/core/src/lib/metrics.ts (только если уже существовал),
#   tests/hippocampus-extraction.test.ts,
#   tests/hippocampus-cap.test.ts
# }

# 12. extractors.ts / gate.ts НЕ тронуты
git diff --name-only HEAD | grep -E 'post/(extractors|gate)\.ts$'
# expect: 0 matches

# 13. arbitration/prompts.ts НЕ тронут (PR-E территория)
git diff --name-only HEAD | grep -E 'arbitration/prompts\.ts$'
# expect: 0 matches

# 14. logger.info arity (3-arg) если новые log calls добавлены
grep -nE 'logger\.(info|warn)\("hippocampus"' packages/agent/src/pipeline/agent-pipeline/post/hippocampus.ts | grep -vE 'logger\.(info|warn)\("hippocampus",\s*"[^"]+",\s*\{'
# expect: 0 matches (каждый call имеет 3-й arg или строго 2-arg variant)

# 15. Нет `as any`
grep -nE '\bas\s+any\b' packages/agent/src/pipeline/agent-pipeline/post/hippocampus.ts packages/agent/src/pipeline/agent-pipeline/post/prompt.ts
# expect: 0 matches
```

**24h/7d post-deploy** (out of scope этого PR — отслеживается after-merge):
- 24h SQL check: `SELECT COUNT(*) AS total, SUM(CASE WHEN created_at > strftime('%s','now')-86400 THEN 1 ELSE 0 END) AS last_24h FROM memory WHERE layer IN ('shared','context');` PASS если PR-A в `reject` mode и whitelist_hits/last_24h == 1.0; PR-A в `warn` mode — `memory_write_validator_triggered_total{enforce_mode="warn"}` rate <5%.
- 7d telemetry: `hippocampus_writes_per_exchange` histogram p95 ≤3 (через grep log entries).
- Manual qual review (юзер сам, 30 random rows за 24h): ≥80% «non-obvious / actionable». Results → `~/vault/RLM/Daily/<date>.md`.

## Definition of Done

Финальный sequential checklist — пройти ВСЕ перед `git commit`. Любой red → STOP, fix root cause, не пропускать.

1. Все 15 команд из § Приёмка прогнаны и зелёные.
2. Diff boundary: `git diff --name-only HEAD` совпадает с разрешённым set ровно (ни один extra файл).
3. `git diff --stat` — суммарное изменение ≤200 строк (sanity check; больше = вероятно scope creep).
4. `git status` clean кроме разрешённых modified/new файлов.
5. Commit message строго: `feat(hippocampus): focused writes (≤3 per exchange) + supersede-aware (PR-D)` + `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` trailer.
6. `git log -1 --name-only` — verify commit existence + correct files.
7. НЕ `git push`, НЕ `gh pr create` — deploy не часть задачи.

## Escape hatch

Если задача провалена — вернуть **одну** строку формата:
```
FAIL: <category>: <≤80-char reason>
```

Categories enum:
- `tsc-error` — `bunx tsc --noEmit` exit ≠0
- `test-fail` — `bun test` regression или новые тесты падают
- `file-cap` — hippocampus.ts или prompt.ts >150 строк после изменений
- `diff-boundary` — затронут файл вне разрешённого списка
- `anti-economy-violation` — grep #8 нашёл запрещённую фразу в prompt
- `signature-changed` — изменена signature `getExtractorPrompt` / `runHippocampus` / `MIN_EXTRACTION_LENGTH`
- `extractors-or-gate-touched` — extractors.ts или gate.ts в diff
- `prompt-rewrite-blocked` — не понял как переписать prompt без violation rule (нужна re-clarification)
- `validator-collision` — новый prompt пишет non-whitelist categories, PR-A блокирует все writes в test
- `unknown` — что-то ещё, описать одной фразой

Пример:
```
FAIL: file-cap: hippocampus.ts grew to 167 lines after counter+telemetry
```
```
FAIL: anti-economy-violation: grep matched "постарайся уложиться" in rule #5
```

## Deploy

```bash
ssh root@109.120.187.244
cd /opt/subbrain
git pull
docker compose build && docker compose up -d
docker compose logs -f | grep -i hippocampus
```

После 24h в prod — acceptance check #1 (SQL). После 7d — acceptance #2 (telemetry).

## Известные ограничения

- A/B fallback (liberal prompt после 5 пустых exchanges) — НЕ в этом PR. Только metric. Если acceptance проседает — follow-up.
- Manual qual review требует юзер-time. Если юзер не делает review в течение 7d — acceptance не закрывается, но deploy не блокируется (telemetry достаточный gate).
- Этот PR pure-textual (90% changes — system prompt). Existing tests должны pass без изменений в логике; меняется только assertion pattern в hippocampus tests.
