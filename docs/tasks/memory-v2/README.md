# Memory v2 roadmap

Состояние: WIP. Источник: RLM-цикл 2026-04-26 (Daily/2026-04-26.md).

13 тикетов трёх приоритетов. P0 — фундамент (M-1, M-2, M-4). P1 — качественный скачок (M-3, M-5, M-6, M-7, M-8). P2 — backlog (M-9, M-10, M-11, M-12, M-13).

| ID | Title | Tier | Effort | Deps |
|---|---|---|---|---|
| M-01 | Close MEM-2 — embed writers для shared_memory | P0 | S | — |
| M-02 | Access tracking columns (last_accessed_at, access_count) | P0 | M | — |
| M-04 | Layer4 episodic-queryable (fts_log + RAG layer "log") | P0 | M | — |
| M-03 | Salience + reinforce-on-access + decay step | P1 | M | M-02 |
| M-05 | Memory edges (A-MEM lite) | P1 | M | — |
| M-06 | Reflect step (CoALA episodic→semantic) | P1 | M | M-02, M-05 |
| M-07 | Memory type/persona (kind enum) | P1 | S | — |
| M-08 | Forgetting curve в retrieval ranking (MemoryBank) | P1 | M | M-02, M-03 |
| M-09 | Cross-layer dedup + archive→shared promote | P2 | M | M-05 |
| M-10 | Public MCP curation tools (link/supersede/promote/reflect) | P2 | S | M-05 |
| M-11 | Sleep-time block rewriter для layer1_focus | P2 | M | — |
| M-12 | Archive confidence HIGH/LOW → REAL | P2 | XS | — |
| M-13 | derived_from→graph API (folded в M-05) | P2 | XS | — |

## Sequencing

```
M-01 ──┐
M-02 ──┼─→ M-03 ─→ M-08
M-04 ──┘         ↘
M-05 ─→ M-06 ─→ M-09 ─→ M-10
M-07 (parallel)
M-11, M-12 (parallel, P2)
```

Recommended:
- **week 1**: M-01, M-02, M-04, M-07 (parallel-safe).
- **week 2**: M-03, M-05.
- **week 3**: M-06, M-08.
- **P2 backlog**: M-09, M-10, M-11, M-12.

## Dispatch protocol

Каждый тикет = 1 PR (один файл `M-NN-<slug>.md` со структурой §Цель/§Файлы/§Изменение/§Тесты/§Приёмка). Dispatch через subagent с `isolation:"worktree"` + parent-side critic-review (см. `~/.claude/skills/dispatch-task-subagent/SKILL.md`). Первый ticket — sequential для проверки протокола; начиная со 2-3 — wave≤3.

## Anti-tickets (что НЕ делать)

- Не вводить отдельную graph DB (Neo4j/Kuzu).
- Не менять embedding model (NVIDIA `nemoretriever-300m` 2048d entrenched).
- Не клонировать Letta as service.
- Не выкатывать `memory_log_search` в public scope без PII-scrub.
- Не открывать validators в open-set категорий.
- Не делать auto-hard-delete по forgetting curve.
- Не embed-ить layer4 целиком (rolling N=10k свежих + FTS достаточно).
