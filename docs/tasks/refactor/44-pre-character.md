# Задача 44 — PR-E: Teamlead + memory character (final pass, low risk)

**Оценка:** 1 час
**Зависимости:** PR-D (задача 43)
**Status:** PENDING
**Spec ref:** [docs/superpowers/specs/2026-05-03-memory-hygiene-and-agent-usefulness.md § PR-E](../../superpowers/specs/2026-05-03-memory-hygiene-and-agent-usefulness.md)

## Цель

Дать synthesis (teamlead) и hippocampus (memory) персональность + verification clause без потери функции. Бьёт R7 (teamlead synthesis prompt — голый «consensus rule», нет verification или personality).

Pure-textual swap. Никаких behavior-changes в коде. Existing tests должны pass без изменений в коде (только в expected output strings если они есть).

PR-E зависит от PR-D (задача 43). Если PR-D ещё не merged — PR-E БЛОКИРОВАН (`getExtractorPrompt()` body должен сначала пройти PR-D rewrite, иначе character paragraph встанет поверх legacy prompt → конфликт rules).

## Контракт исполнителя

Эта задача — **pure textual swap**. Только два файла, только тело двух функций. Никаких schema/behavior/import/dep/test-logic changes.

**Allowed actions:**
- Edit `packages/agent/packages/agent/packages/agent/src/pipeline/arbitration/prompts.ts` — переписать тело `buildSynthesisSystemPrompt()`. Signature не менять. Если есть параметры (specialists list, etc.) — продолжать их использовать в новом тексте.
- Edit `packages/agent/packages/agent/packages/agent/packages/agent/src/pipeline/agent-pipeline/post/prompt.ts` — prepend character paragraph в начало возвращаемого `getExtractorPrompt()` body (поверх PR-D rules). Signature не менять.
- Если existing tests assert'ят дословные фразы старого prompt'а (e.g. `expect(prompt).toContain('consensus rule')`) — обновить assertions на новые phrases. **Только** assertion strings, не logic.
- `bunx tsc --noEmit`, `bun test`, `bun run scripts/check-file-size.ts`.
- `git commit -m "feat(prompts): teamlead verification + hippocampus character (PR-E)"`.

**Hard NO-GO:**
- НЕ менять signatures `buildSynthesisSystemPrompt`, `getExtractorPrompt`.
- НЕ менять никаких других функций / экспортов / типов.
- НЕ trogать `hippocampus.ts`, `extractors.ts`, `gate.ts` (PR-D территория, уже merged).
- НЕ trogать `arbitration-room.ts` (synthesis caller, поведение не меняется).
- НЕ менять `MAX_HIPPO_STEPS`, `MAX_WRITES_PER_EXCHANGE`, `MIN_EXTRACTION_LENGTH`.
- НЕ создавать новый файл, env var, helper, const.
- НЕ менять test logic (только assertion strings если необходимо).
- В новом тексте НЕ писать «save tokens» / «be efficient» / «постарайся уложиться» / «не пиши слишком много» / «не используй tool без нужды» (anti-economy).
- НЕ параметризировать тон через env (`TEAMLEAD_TONE`) — YAGNI, явно out-of-scope.
- НЕ `git push`, НЕ `gh`, НЕ `--no-verify`.
- НЕ запускать prod / docker / ssh — deploy не часть задачи.

**Diff boundary:** ровно два файла:
```
packages/agent/packages/agent/src/pipeline/arbitration/prompts.ts
packages/agent/packages/agent/packages/agent/src/pipeline/agent-pipeline/post/prompt.ts
```
Опционально (только если existing tests assert старые фразы):
```
tests/arbitration-room.test.ts
tests/hippocampus-extraction.test.ts
```
Любой extra файл = STOP, FAIL.

**Output contract:** `OK <sha7> feat(prompts): teamlead verification + hippocampus character (PR-E)` или `FAIL: <reason>`.

## Файлы

- [packages/agent/packages/agent/src/pipeline/arbitration/prompts.ts](../../../packages/agent/packages/agent/src/pipeline/arbitration/prompts.ts) — `buildSynthesisSystemPrompt()` text.
- [packages/agent/packages/agent/packages/agent/src/pipeline/agent-pipeline/post/prompt.ts](../../../packages/agent/packages/agent/packages/agent/src/pipeline/agent-pipeline/post/prompt.ts) — `getExtractorPrompt()` (тот же файл что в PR-D, но другая часть текста — добавить character paragraph над rules).

## Изменение

### 1. Teamlead synthesis prompt

Заменить current `buildSynthesisSystemPrompt()` тело на:

```
Ты — рассудительный тимлид. Не угождаешь, не льстишь. Если specialists ошибаются — называй это прямо. Объясняешь WHY, не просто WHAT.

КОНТЕКСТ: тебе передаются ответы N specialists на один вопрос юзера. Твоя задача — synthesize их в единый final answer для юзера.

VERIFICATION CLAUSE (обязательно):
- Прежде чем merge consensus — проверь, нет ли тривиального counter-example который ни один specialist не заметил.
- Если specialist N hedges ("вероятно", "возможно", "скорее всего", "не уверен но") — НЕ присваивай его голосу полный вес. Hedge = lower confidence, не нейтрально.
- Если specialists конфликтуют — назови конфликт прямо. «Specialist A считает X, specialist B считает Y. Я согласен с A потому что Z.»
- Не округляй разногласия до «mostly agreed» если их нет.

ТОН:
- Прямой. Без «давайте рассмотрим...». Сразу к делу.
- Без хеджа в собственном выводе. Если уверен — говори. Если не уверен — говори ЧТО именно неопределённо.
- Не повторяй specialist'ов слово в слово. Synthesize means understand-then-restate, не concat.

OUTPUT: финальный ответ юзеру. Не упоминай specialists / arbitration mechanic — это инфра, юзеру не нужно.
```

### 2. Hippocampus character (добавить в верх promptа из PR-D)

В [packages/agent/packages/agent/packages/agent/src/pipeline/agent-pipeline/post/prompt.ts](../../../packages/agent/packages/agent/packages/agent/src/pipeline/agent-pipeline/post/prompt.ts), prepend (или объединить с PR-D §1 строкой 1):

```
Ты — гиппокамп этого юзера. Твоя работа — отбирать сигнал из шума.

Ты НЕ stenographer. Ты НЕ архивист. Ты — фильтр на surprising / non-obvious / actionable. Скучные факты не сохраняются — они забываются. Это твой default.

Каждое решение «писать или не писать» — личное. Если ты бы запомнил это, услышав от друга через год — пиши. Если это тривиальная оперативка («сейчас обсуждаем X») — пропускай.
```

После этого — все правила из PR-D (memory_search pre-write, whitelist, DO-NOT-SAVE list, баланс).

## Тесты

Existing `tests/arbitration-room.test.ts` — pass без изменений (поведение synthesis не меняется, только текст промпта).

Existing `tests/hippocampus-extraction.test.ts` — pass без изменений (PR-D уже обновил под новые expectations; PR-E — только character paragraph над rules).

Нет новых тестов. Manual qual review достаточен.

## Premortem

| # | Симптом | Mitigation | Recovery |
|---|---------|------------|----------|
| 1 | Existing test assert'ит дословную старую фразу из synthesis prompt → red после edit | Перед edit: `grep -nE 'consensus rule\|merge specialists' tests/arbitration-room.test.ts` — найти assertions. Обновить ровно те strings; logic НЕ трогать. | Если test falt'ит на logic-проверке (не string) — это сигнал что PR-E случайно изменил behavior. Откатить edit, перечитать § Изменение. |
| 2 | Hippocampus character paragraph конфликтует с PR-D rule #1 (cap=3) — LLM получает противоречие | PR-E paragraph декларативный («ты — гиппокамп, фильтр»), PR-D rules — императивные («≤3 writes»). Разные слои, не конфликт by design. Прочесть итоговый prompt руками после edit — должен читаться как один coherent текст. | Если LLM в test'е игнорирует cap (>3 writes) — возможно paragraph «overrides» rule. Уменьшить character paragraph до 2 строк, перенести «фильтр» semantic в rule #1 PR-D. |
| 3 | Файл-кап 150 строк сломан после prepend в `prompt.ts` (PR-D уже мог его раздуть) | Перед commit: `wc -l packages/agent/packages/agent/packages/agent/src/pipeline/agent-pipeline/post/prompt.ts ≤150`. Character paragraph короткий (~5-8 строк) — должно влезть. | Если >150 — extract character paragraph в const HIPPO_CHARACTER в этом же файле и concat при return; экономит 0 строк, но if не помогает — проверить не разрослись ли rules в PR-D, обсудить с юзером split. |
| 4 | `arbitration/prompts.ts` имеет несколько exported функций — переписали не ту | `grep -nE '^export (function\|const) build' packages/agent/packages/agent/src/pipeline/arbitration/prompts.ts` — найти все. Менять ровно `buildSynthesisSystemPrompt`. | Если перепутали (e.g. изменили `buildSpecialistPrompt`) — `git diff` покажет. Revert hunk, повторить на правильной функции. |
| 5 | Anti-economy violation в новом тексте | Hard NO-GO + grep guard в § Приёмка: `grep -niE 'save token\|be efficient\|постарайся уложиться\|не пиши слишком много\|не используй tool без нужды' packages/agent/packages/agent/src/pipeline/arbitration/prompts.ts packages/agent/packages/agent/packages/agent/src/pipeline/agent-pipeline/post/prompt.ts → 0`. | Match → переписать violation-фразу. Verification clause НЕ требует economy-language; «не угождай» ≠ «save tokens». |
| 6 | Юзеру не понравится тон synthesis (subjective) | Acceptance в § Приёмка явно отмечает manual qual review через 7d. Если тон не зайдёт — `git revert <commit>` мгновенно. | НЕ параметризовать через env в этом PR (YAGNI per spec). Revert + follow-up PR с исправленным тоном если нужно. |
| 7 | Синтаксис prompt'а сломан (несбалансированные кавычки в template literal, ломает tsc) | `bunx tsc --noEmit` после edit обязательно. Template literal с русскими кавычками `«»` — ok, но обычные `"` внутри backticks без escape — может сломать. | tsc выдаст конкретную строку. Escape или заменить на типографские кавычки. |
| 8 | `getExtractorPrompt` имеет параметры (e.g. `previousFacts: string[]`) которые character paragraph не использует | Прочесть signature перед edit. Если параметры есть — они должны продолжать interpolate'иться в rules section (PR-D). Character paragraph parameter-free — это нормально, он static. | Если параметр перестал использоваться → tsc warn (unused). Решение: либо вернуть use в rules, либо drop параметр (но это уже scope-creep — STOP, FAIL). |
| 9 | Тон в teamlead «не угождай» воспринимается LLM как агрессия → грубые ответы юзеру | В prompt'е явно: «прямой» + «WHY» + «verification» — не «грубый». Manual qual review отлавливает. | Если post-deploy юзер видит грубость — `git revert`, follow-up с softer wording («прямой но уважительный»). |

## Приёмка

```bash
# 1. TypeScript clean
bunx tsc --noEmit
# expect: exit 0

# 2. Full suite — ZERO regressions (pure textual change)
bun test 2>&1 | tail -3
# expect: "0 fail"

# 3. File caps
bun run scripts/check-file-size.ts
# expect: exit 0
wc -l packages/agent/packages/agent/src/pipeline/arbitration/prompts.ts packages/agent/packages/agent/packages/agent/src/pipeline/agent-pipeline/post/prompt.ts
# expect: оба ≤150

# 4. Teamlead new phrases active
grep -nE 'рассудительный тимлид|verification|hedges?' packages/agent/packages/agent/src/pipeline/arbitration/prompts.ts
# expect: ≥3 matches (3 ключевых слова из нового prompt'а)

# 5. Hippocampus character paragraph active
grep -nE 'гиппокамп|surprising|stenographer|архивист' packages/agent/packages/agent/packages/agent/src/pipeline/agent-pipeline/post/prompt.ts
# expect: ≥3 matches

# 6. PR-D rules сохранены (character НЕ перезатёр rules)
grep -nE 'memory_search.*candidate|MAX_WRITES_PER_EXCHANGE|whitelist' packages/agent/packages/agent/packages/agent/src/pipeline/agent-pipeline/post/prompt.ts
# expect: ≥1 match (rules из PR-D всё ещё на месте)

# 7. Anti-economy guard
grep -niE 'save token|be efficient|постарайся уложиться|не пиши слишком много|не используй tool без нужды' packages/agent/packages/agent/src/pipeline/arbitration/prompts.ts packages/agent/packages/agent/packages/agent/src/pipeline/agent-pipeline/post/prompt.ts
# expect: 0 matches (HARD FAIL если хоть один)

# 8. Signatures сохранены
grep -nE 'export function buildSynthesisSystemPrompt\b' packages/agent/packages/agent/src/pipeline/arbitration/prompts.ts
# expect: ≥1 match
grep -nE 'export function getExtractorPrompt\b' packages/agent/packages/agent/packages/agent/src/pipeline/agent-pipeline/post/prompt.ts
# expect: ≥1 match

# 9. Diff boundary — ровно 2-4 файла из allowed set
git diff --name-only HEAD
# expect: subset of {
#   packages/agent/packages/agent/src/pipeline/arbitration/prompts.ts,
#   packages/agent/packages/agent/packages/agent/src/pipeline/agent-pipeline/post/prompt.ts,
#   tests/arbitration-room.test.ts          # только если assertion strings updated
#   tests/hippocampus-extraction.test.ts    # только если assertion strings updated
# }

# 10. hippocampus.ts / extractors.ts / gate.ts / arbitration-room.ts НЕ тронуты
git diff --name-only HEAD | grep -E 'post/(hippocampus|extractors|gate)\.ts$|arbitration-room\.ts$'
# expect: 0 matches

# 11. MAX_* константы сохранены (если они в этих файлах есть — не должны меняться)
grep -nE 'MAX_HIPPO_STEPS\s*=' packages/agent/packages/agent/packages/agent/src/pipeline/agent-pipeline/post/prompt.ts || true
grep -nE 'MAX_WRITES_PER_EXCHANGE\s*=' packages/agent/packages/agent/packages/agent/src/pipeline/agent-pipeline/post/prompt.ts || true
# expect: либо 0 matches (если константы в hippocampus.ts), либо same value что был

# 12. Никаких новых imports / exports не добавлено в эти файлы
git diff packages/agent/packages/agent/src/pipeline/arbitration/prompts.ts packages/agent/packages/agent/packages/agent/src/pipeline/agent-pipeline/post/prompt.ts | grep -E '^\+(import|export)'
# expect: 0 lines (pure body edit, no new imports/exports)

# 13. Нет `as any`
grep -nE '\bas\s+any\b' packages/agent/packages/agent/src/pipeline/arbitration/prompts.ts packages/agent/packages/agent/packages/agent/src/pipeline/agent-pipeline/post/prompt.ts
# expect: 0 matches
```

**Manual qual review (post-deploy, не блокирует commit):** юзер сам, после 7d prod — synthesis output noticeably less wishy-washy + hippocampus character не делает результат хуже. Запись в `~/vault/RLM/Daily/<date>.md`. Если негатив — `git revert` (PR-E pure-textual, revert безопасен).

## Definition of Done

Sequential checklist — пройти ВСЕ перед `git commit`:

1. Все 13 команд из § Приёмка прогнаны и зелёные.
2. Diff boundary: `git diff --name-only HEAD` ровно 2 (или 3-4 если updated test assertions).
3. `git diff --stat` суммарно ≤80 строк (sanity: pure-textual swap не должен быть большим; >80 = вероятно что-то лишнее).
4. `git diff packages/agent/packages/agent/src/pipeline/arbitration/prompts.ts | grep -E '^\+\+\+' | wc -l` = 1 (один файл-target).
5. Final читабельность: открыть оба changed prompt'а руками, прочесть как coherent текст. Если character paragraph + PR-D rules = «сшивка» (повторы, противоречия) → STOP, fix.
6. Commit message строго: `feat(prompts): teamlead verification + hippocampus character (PR-E)` + `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` trailer.
7. `git log -1 --name-only` — verify.
8. НЕ `git push`, НЕ `gh`.

## Escape hatch

Одна строка формата:
```
FAIL: <category>: <≤80-char reason>
```

Categories:
- `tsc-error` — `bunx tsc --noEmit` exit ≠0
- `test-fail` — full suite regression (PR-E pure-textual, тесты должны pass)
- `file-cap` — prompts.ts или prompt.ts >150 строк
- `diff-boundary` — затронут файл вне 2 (+2 опциональных tests)
- `anti-economy-violation` — grep #7 matched
- `signature-changed` — изменена signature buildSynthesisSystemPrompt / getExtractorPrompt
- `wrong-function` — переписали другую функцию (e.g. buildSpecialistPrompt вместо buildSynthesisSystemPrompt)
- `pr-d-rules-lost` — character paragraph случайно перезатёр PR-D rules (grep #6 = 0)
- `prompt-incoherent` — итоговый текст читается как сшивка повторов/противоречий, нужен manual rewrite
- `unknown` — что-то ещё

Пример:
```
FAIL: file-cap: prompt.ts now 156 lines after prepending character paragraph
```
```
FAIL: pr-d-rules-lost: PR-D rule #1 (MAX_WRITES_PER_EXCHANGE) accidentally removed during prepend
```

## Deploy

```bash
ssh root@109.120.187.244
cd /opt/subbrain
git pull
docker compose build && docker compose up -d
```

Никаких миграций / env-changes / DB-snapshots. Pure prompt swap, мгновенный revert через git revert если что.

## Известные ограничения

- Никакие other agent prompts (free, research, clear, check-tg, find-new-task) НЕ трогаем — они уже имеют character/anti-economy через PR-C2/C3.
- Если в будущем понадобится A/B test разных тонов teamlead — env параметр + 2 const'ы. Сейчас YAGNI.
- Hippocampus character paragraph должен «mesh» с PR-D rules — НЕ конфликтовать. Проверить вручную после edit что общий prompt читается как один coherent текст, не как сшивание.
