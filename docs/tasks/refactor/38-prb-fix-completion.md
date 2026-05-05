# Задача 38 — PR-B merge worktree → main

**Оценка:** 5 мин
**Зависимости:** PR-A merged (commit `ea3e910`)
**Status:** DONE (merge complete)

## Контекст

PR-B (night janitor + restore endpoint) **полностью готов** в worktree-branch `worktree-agent-a24c5a9c224b06ce3`. Два коммита уже на ветке:

```
f9e65e0 fix(memory): PR-B janitor critic round-1 fixes
6bfdee4 feat(memory): PR-B night janitor + restore endpoint
ea3e910 (main) merge(PR-A): memory hygiene schema enforcement + dedup + TTL
```

`main` пока на `ea3e910`. Эта задача — **merge ветки на main одной операцией**. Никакого нового кода, никаких правок.

## Контракт исполнителя

Это **чистый git merge**. Любая правка `.ts` / `.vue` / `.md` файла = scope creep = FAIL.

**Allowed actions** (только эти):
- `git status`, `git diff`, `git log`, `git branch`, `git worktree list` — read-only.
- `cd /usr/projects/subbrain && git merge --no-ff -X theirs <branch>` — единственная mutating команда.
- `bunx tsc --noEmit` — verify после merge.
- `bun test` — verify после merge.
- `git worktree remove`, `git branch -D` — cleanup ПОСЛЕ успешного merge.

**Hard NO-GO:**
- НЕ `git rebase`, НЕ `git reset`, НЕ `git push`, НЕ `gh`.
- НЕ `--no-verify`, НЕ amend.
- НЕ редактировать **никакой файл**. Если tsc/tests fail после merge — сразу FAIL, parent reconcile.
- НЕ `docker`, НЕ `ssh` — deploy не часть задачи.
- НЕ создавать новые worktree, НЕ делать новые коммиты в worktree.
- **НЕ запускать `/task` skill** — задача механическая, RLM-цикл не нужен. Прямое выполнение шагов §Шаги.

**Diff boundary:** после merge `git log main -2` обязан показать СТАРЫЕ коммиты `f9e65e0` и `6bfdee4` (sha не меняется при `--no-ff` merge — они становятся parents merge-commit'а), плюс новый merge-commit. Любой rewrite sha = STOP.

**Output contract:** при успехе — `OK <merge-sha7> merge(PR-B): janitor + critic round-1`. При FAIL — одна строка `FAIL: <category>: <reason>` (см. §Escape hatch).

## Шаги выполнения

```bash
# 0. Pre-check — состояние ровно как в §Контекст
cd /usr/projects/subbrain
git log -1 --format='%h' main                                    # MUST = ea3e910
git log -1 --format='%h %s' worktree-agent-a24c5a9c224b06ce3     # MUST = f9e65e0 ...critic round-1
git rev-list main..worktree-agent-a24c5a9c224b06ce3 --count      # MUST = 2

# 1. Merge
git merge --no-ff -X theirs worktree-agent-a24c5a9c224b06ce3 \
  -m "merge(PR-B): janitor + critic round-1"

# 2. Verify
bunx tsc --noEmit                                                # MUST exit 0
bun test 2>&1 | tail -3                                          # MUST: pass count >= 900, fail <=2

# 3. Cleanup
git worktree remove -f -f .claude/worktrees/agent-a24c5a9c224b06ce3
git branch -D worktree-agent-a24c5a9c224b06ce3
```

## Premortem

| # | Симптом | Mitigation | Recovery |
|---|---------|-----------|----------|
| 1 | Pre-check показал main ≠ ea3e910 (кто-то уже merge'нул) | `git log --oneline -5 main` посмотри не в нём ли уже PR-B | если уже merged → задача DONE без действий, верни OK с существующим merge-sha |
| 2 | Worktree branch не существует (snесли) | `git branch -a \| grep worktree-agent` | `FAIL: worktree-missing: ...` — parent decides |
| 3 | Merge conflict на `.ts/.vue` | `-X theirs` НЕ безопасен для кода — abort | `git merge --abort` → `FAIL: code-conflict: <files>` |
| 4 | tsc errors после merge | НЕ редактировать код. Code-bug в worktree commits | `git reset --merge HEAD~1` → `FAIL: tsc-error: <первая ошибка>` |
| 5 | bun test регрессия > 2 fails (relative to ea3e910 baseline) | env flake не считается, проверь tail повторно | `git reset --merge HEAD~1` → `FAIL: test-regression: <N> fails` |
| 6 | Worktree locked → cleanup падает | `git worktree unlock <path>` потом remove | если падает повторно — `FAIL: cleanup-incomplete: ...` (worktree остался, но merge сделан — это OK для main) |
| 7 | Merge сделан, но `git status` parent dirty (untracked task files в `docs/tasks/refactor/3*.md`) | norm — это task files которые редактируются live | игнорировать, не трогать untracked |

## Приёмка

```bash
cd /usr/projects/subbrain

# После merge
git log -1 --format=%s main                                     # expect: starts with "merge(PR-B):"
git log main -3 --format='%h %s'                                # expect: merge-commit, f9e65e0, 6bfdee4
git rev-parse main^1                                            # expect: ea3e910 (first parent)
git rev-parse main^2                                            # expect: f9e65e0 (merged branch tip)

bunx tsc --noEmit                                               # expect: exit 0
bun test 2>&1 | tail -3                                         # expect: "X pass / 0-2 fail" (env-only)

# Cleanup verified
git worktree list | grep -c agent-a24c5a9c224b06ce3             # expect: 0
git branch | grep -c worktree-agent-a24c5a9c224b06ce3            # expect: 0

# Content checks (на main, после merge)
grep -c 'original_category' packages/agent/packages/agent/src/services/memory/archive-restore.ts        # expect: >=1
grep -c 'buildEmbeddingMap' packages/agent/packages/agent/packages/agent/src/pipeline/night-cycle/janitor/phase-b-embed.ts  # expect: >=1
test -f packages/agent/packages/agent/packages/agent/src/pipeline/night-cycle/janitor/phase-b-embed.ts && echo OK      # expect: OK
```

## Definition of Done

Перед `OK <sha>` ответом проверить **последовательно** (каждый шаг blocking):

1. ✅ `git log -1 --format=%s main` начинается с `merge(PR-B):`
2. ✅ `git rev-parse main^2` = `f9e65e0` (worktree-branch tip)
3. ✅ `bunx tsc --noEmit` exit 0
4. ✅ `bun test 2>&1 | tail -3` показывает ≤2 fail
5. ✅ `git worktree list` НЕ содержит `agent-a24c5a9c224b06ce3`
6. ✅ `git branch` НЕ содержит `worktree-agent-a24c5a9c224b06ce3`

Если ЛЮБОЙ из 6 пунктов fail → НЕ возвращать OK, идти в Escape hatch.

## Escape hatch

При FAIL — **одна строка** в stdout:

```
FAIL: <category>: <≤80-char specific reason>
```

Categories: `pre-check-mismatch` | `worktree-missing` | `code-conflict` | `tsc-error` | `test-regression` | `cleanup-incomplete` | `unknown`.

После FAIL — **остановиться**. НЕ rollback merge без явной причины (только п.4 и п.5 premortem требуют `git reset --merge HEAD~1`). НЕ `git push`. НЕ удалять worktree если merge не сделан. Parent смотрит и решает.

## Известные ограничения

- Worktree branch может уже не существовать (cleanup был раньше). Тогда merge невозможен — задача off-the-table.
- Если main уже advanced beyond ea3e910 (другие PR'ы merged) — pre-check 0 fail'ит, parent должен пересоздать worktree-branch на актуальный main и retry.
- `-X theirs` безопасен ТОЛЬКО для doc-конфликтов. Если merge тащит .ts/.vue conflict — abort немедленно.
