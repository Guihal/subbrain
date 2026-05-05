# Workflow-spec — consolidated draft (input для RLM-синтеза)

> Это **draft / brain-dump**, не финальный spec. Из него RLM-цикл `/task` должен синтезировать два чистых документа: universal-shareable + personal-subbrain.

---

## Часть A — Исходный черновик юзера (v1)

### 0. Базовая интуиция

Сильная модель дорогая, слабая дешёвая. Качество слабой компенсируется **рельсами + RLM-циклом**: ставим максимум физических ограничений, чтобы пространство ошибок было узким, и гоняем верификацию пока не сходится. Сильная модель работает там, где рельсы поставить нельзя — в архитектуре, плане, ревью.

Это разделение труда по типу когнитивной нагрузки, а не по сложности задачи.

### 1. Распределение ролей

| Роль | Модель | Задача |
|---|---|---|
| Архитектор / планировщик | Claude (Opus для тяжёлых решений, Sonnet для рутины) | Декомпозиция, контракты, спорные tradeoffs, ревью |
| Реализатор | Kimi / DeepSeek / другая дешёвая | Кодогенерация по спеке внутри рельсов |
| Верификатор | Та же дешёвая | Запуск тестов, чтение ошибок, итерации в RLM-цикле |
| Полировщик | Claude Sonnet | Финальный проход по качеству, имена, читаемость |

**Принцип:** дешёвая модель никогда не принимает архитектурных решений. Если она упёрлась во что-то, что требует выбора между двумя путями — стоп, эскалация в Claude.

### 2. Pipeline (от задачи до мерджа)

#### Stage 1 — План (Claude + RLM)
- Claude получает задачу + контекст проекта
- RLM-цикл: Claude пишет план → критикует свой план → правит
- Выход: документ с **контрактами** (что на входе, что на выходе, инварианты), списком файлов, оценкой сложности

#### Stage 2 — Декомпозиция (Claude)
- План режется на **волны** независимых задач
- Внутри волны задачи параллелятся, между волнами — последовательно
- Каждая задача = атомарный юнит ≤ 150 LOC, с явным контрактом и acceptance criteria

#### Stage 3 — Реализация (дешёвая модель + RLM + рельсы)
- Запуск через `claude-code` в режиме agent_teams (параллельные агенты)
- Каждый агент видит **только свой контекст**: контракт + соседние интерфейсы, не весь проект
- RLM-цикл: реализация → tsc + biome + tests → правка → повтор до зелёного

#### Stage 4 — Чекпоинты (executable verification)
- После каждой волны: модель **руками запускает** код, не просто тесты
  - Поднять локальный сервер, дёрнуть endpoint, посмотреть что вернулось
  - Открыть UI, прокликать сценарий
  - Проверить на реальных данных, не на моках
- Это ловит половину ошибок которые тесты пропускают (неправильные форматы, кривая интеграция, регрессии в UX)

#### Stage 5 — Полировка (Claude)
- Финальный ревью: имена, дубликаты, упущенные edge cases
- Pre-mortem: «что сломается через месяц» — отдельным проходом

### 3. Физические рельсы (обязательны для слабой модели)

#### TypeScript
- `strict: true` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` + `noImplicitOverride`
- `no any`, `no @ts-ignore` (только `@ts-expect-error` с комментарием почему)
- `no enum` — использовать `const`-объекты + `as const`
- `no type assertions` (`as X`) без `// SAFE:` комментария с обоснованием

#### Линт / форматирование
- Biome strict, max-warnings = 0
- ESLint правила: `no-floating-promises`, `no-misused-promises`, `require-await`, `no-explicit-any`, `consistent-type-imports`
- Pre-commit hook: tsc + biome + tests

#### Размер / сложность
- **150 LOC на файл** (твой cap, оставляем)
- ≤ 50 строк на функцию
- Cyclomatic complexity ≤ 10
- ≤ 4 параметра на функцию (дальше — объект)
- Глубина вложенности ≤ 3

#### Структура
- Boundary-тесты на слои (у тебя уже есть)
- Запрет циклических импортов
- Один файл — одна экспортируемая единица (модуль/компонент/composable)

### 4. Правила хорошего кода — расширенный список

(Сгруппировано по слоям проблемы. `[A]` — особо важно для агентов, `[U]` — universal.)

#### 4.1. Типы как доказательства

**Branded types для ID и валидированных значений** `[A][U]`
```ts
type UserId = string & { __brand: 'UserId' }
type Email = string & { __brand: 'Email' }
```
Решает: модель не может случайно передать `productId` туда где ждут `userId`.

**Discriminated unions вместо optional флагов** `[A][U]`
```ts
// плохо
type Result = { ok: boolean, data?: T, error?: string }
// хорошо
type Result<T> = { ok: true, data: T } | { ok: false, error: string }
```

**Readonly by default** `[U]` — `readonly` на полях, `ReadonlyArray<T>`, мутации только в явных местах с комментарием.

**Result/Either вместо throw для ожидаемых ошибок** `[A]` — `throw` только для невозможных состояний (баг, инвариант сломан); ожидаемое (валидация, сеть, БД) — типизированный результат.

**Schema-first на всех IO-границах** `[A][U]` — zod/valibot для входов API, env, форм, парсинга. Тип выводится из схемы. Никакого «доверия» внешним данным.

#### 4.2. Архитектура

- **Hexagonal / ports & adapters** `[U]` — domain не знает о БД, HTTP, файлах. Зависимости через интерфейсы.
- **Pure core, imperative shell** `[U]` — бизнес-логика чистые функции, IO на периферии.
- **Composition over inheritance** `[U]` — никаких abstract-классов «на вырост». В TS наследование = почти всегда code smell.
- **Dependency direction** `[A]` — UI → app → domain ← infra. Domain — центр.
- **No god objects, no `-Service` / `-Manager` / `-Helper` / `-Util`** `[A]` — имя должно говорить **что объект делает**.
- **Feature folders, не technical folders** `[U]` — `features/checkout/` лучше чем `controllers/`/`services/`/`models/`.

#### 4.3. Имена

- Глаголы для функций, существительные для значений `[U]`
- Boolean: `is/has/can/should/will` `[U]`
- Длина имени ∝ scope `[U]`
- Domain language, не technical — `customer`, не `userRecord` `[U]`
- No magic numbers/strings — именованные константы `[A][U]`
- Аббревиатуры — только общепринятые `[U]`

#### 4.4. Ошибки

- **Fail fast** `[U]`
- **Errors as discriminated unions** `[A]`
- **No empty catch** `[A]`
- **Errors на правильном уровне** `[U]` — низкоуровневые ловятся и оборачиваются в доменные на границе.

#### 4.5. Тесты

- Тесты на поведение, не реализацию `[U]`
- AAA: Arrange / Act / Assert `[A][U]`
- Тестовая пирамида: много unit, средне integration, мало e2e `[U]`
- Property-based для алгоритмов (`fast-check`) `[U]`
- Coverage не цель — мутационное тестирование (`stryker`) реальная мера `[U]`
- No mocks внутри домена `[A]`

#### 4.6. Контракты и спецификации

- **Контракт перед кодом** `[A]` — input type, output type, инварианты, error cases.
- **ADR на значимые решения** `[U]` — `docs/adr/0042-why-elysia.md`.
- **README на модуль** `[U]`.
- **OpenAPI/JSON Schema на API** `[A][U]` — источник правды для границ.

#### 4.7. Зависимости

- Минимум зависимостей.
- Закреплённые версии (lockfile).
- `npm/bun audit` регулярно.
- Wrappers для внешних библ на boundary.
- Никаких полу-мёртвых пакетов.

#### 4.8. Процесс / git

- Conventional commits
- Атомарные коммиты
- PR ≤ 400 LOC diff
- Одна ветка — одна задача
- Squash при мердже

#### 4.9. Производительность

- Не оптимизируй до измерения `[U]`
- Профилировать, потом править
- N+1 — ловить на ревью обязательно
- Кеши явные: TTL, invalidation strategy, owner кеша
- Streams для больших данных
- `O(n²)` на коллекциях >100 = blocker

#### 4.10. Безопасность

- Валидация на всех входных границах (zod)
- Параметризованные SQL
- HTML escape по умолчанию
- Секреты только в env
- Principle of least privilege
- CSRF/CORS политики осознанные
- Зависимости с известными уязвимостями — не мерджим

### 5. Специфично для агентов

#### 5.1. Контекст-менеджмент

Каждый агент видит только то что нужно: контракт задачи + интерфейсы соседних модулей + релевантные файлы (≤ 5). Полный проект агенту никогда не показываем.

#### 5.2. Жёсткий формат вывода

Контракт на формат ответа (zod-схема для structured output). Никаких «вот ваш код, надеюсь поможет» — только код или только diff. Ошибки — в типизированном формате.

#### 5.3. Чек-листы before/after

**Before:** понял контракт? знаю границы задачи? все типы/интерфейсы в контексте?
**After:** tsc? biome? тесты? **запустил** код? LOC < 150? нет TODO без issue?

#### 5.4. Запрет на новые абстракции без аргументации

Слабая модель любит создавать «универсальные» хелперы → энтропия растёт. Правило: новый класс/абстракция = комментарий «зачем» + минимум 2 текущих использования (правило трёх).

#### 5.5. «Сначала упрости — потом добавь»

Если задача не лезет — не наваливать ещё кода, а упрощать. RLM-цикл должен включать вопрос «можно ли это сделать меньшим количеством кода?»

#### 5.6. Verification ≠ implementation

Агент-реализатор и агент-верификатор — **разные вызовы**. Реализатор пишет, верификатор читает с холодной головы и проверяет против контракта.

#### 5.7. Эскалация

Жёсткие триггеры эскалации к Claude:
- Конфликт двух требований контракта
- Нужно изменить публичный интерфейс
- >2 итераций RLM не сходятся
- Появляется потребность в новой зависимости

### 6. Открытые вопросы (получены ответы — см. Часть C)

### 7. Что не вписал, но стоит подумать (резерв)

- Observability (детали в Часть B / C)
- Feature flags
- Backward compatibility на API
- Database migrations — атомарные, обратимые, тестируются на копии прод-данных
- Запасной план если LLM-провайдер ляжет (локальная инференция)

---

## Часть B — Дополнения от Claude (большой контекст, опыт subbrain)

### A. Reasoning-state-loss дешёвых моделей (КРИТИЧНО)

Прецедент 2026-05-04: Kimi K2.6 через ccr-proxy зациклилась на 2700×Read одной директории (EISDIR), не переключилась на `ls`. Корень — proxy теряет `thinking` field между турами → модель не помнит свой previous reasoning → retry identical call.

**Правило обязательно для любого weak-model workflow:**
- `is_error: true` → НЕ retry same tool same args. Сменить инструмент.
- Recovery table:
  - `Read` → ENOENT → `ls/Glob` parent dir
  - `Read` → EISDIR → `ls` (это директория)
  - `Edit` → "old_string not found" → Read first
  - `Bash` → command-not-found → check PATH/`which`
  - `Grep`/`Glob` → no matches → валидный результат, не error
- Hooks как backstop (post-loop guard).

В черновике этого нет — добавить отдельной секцией.

### B. Memory bootstrap pattern

На старте сессии: `memory_search` по cwd+branch+первое-сообщение → подсасывает shared knowledge → не повторяешь прошлые решения. Применимо к любому проекту с MCP-памятью (Subbrain, ChromaDB, Mem0, etc.). В spec — отдельной секцией про cross-session continuity.

### C. Observability для агентов (детализация)

Минимум:
- Каждый step structured log: `{tool, args_truncated, result_code, duration_ms, traceId}`
- TraceID = `sessionId + stepN`, прокидывается через subagent spawn
- Метрики ловящие патологии: **tool retry rate > 1 = bad**, step count distribution, RLM iter count, escalation rate
- Без этого «непонятно что упало» = blind faith
- Tier 1 backend: Helicone (one-line proxy install)
- Tier 2 backend: OpenTelemetry GenAI semconv (vendor-agnostic standard, March 2026)

### D. Tier'ы для shareable spec

Без тиров новичок утонет. Структура:
- **Tier 0 (5 min):** AGENTS.md с 3 правилами + pre-commit (tsc+lint) + 1 руль (file cap)
- **Tier 1 (1 час):** + RLM /task skill + контракт-фолдер + verifier-pattern
- **Tier 2 (день):** + agent_teams волны + observability + cost watcher

### E. Anti-patterns каталог

Каталог «как НЕ надо» для слабой модели:
- Defensive programming на каждом углу → LOC растёт, баги прячет
- TODO без issue → мусор накапливается
- `as any` для скорости → типы перестают защищать
- Helper с одним использованием → энтропия
- `catch {}` → silent failure
- "Сделаю generic на будущее" → over-engineering

### F. Rollback strategy для волн

Опыт subbrain chapter-16: 14/14 PR смерджены параллельно — **6 дали HIGH регрессии (43% брака)**. Параллельность ≠ корректность.

- Pre-merge integration: волна PR сначала в одной staging-ветке → run full suite → потом split на individual PR на main
- Post-merge audit обязателен (отдельная RLM волна с критиком на reconcile commit)
- Reconcile commit = explicit checkpoint, к нему откатываешься

### G. Prompt-гигиена для волн

Один common system prompt (shared rules) + per-task contract (specific). НЕ дублировать guardrails в каждом промпте — раздувает контекст и расходится при правке.

### H. Cost-budget per feature

Дешёвая модель тоже стоит когда крутишь 100 итераций × 5 параллельных. Hard cap `$X на feature`. При превышении → стоп + эскалация. **$-watcher с per-feature scope**, не token-watcher per call.

### I. Spec-driven подход (parent paradigm)

Spec-first → потом код. Растущий стандарт. Источники: addyosmani/agent-skills, obra/superpowers (178k⭐), OpenSpec, GitHub Spec Kit. Упомянуть как parent paradigm, не как новинку.

### J. Skill-decomposition системного промпта

Cursor паттерн: `.cursor/index.mdc` как router → load specific rules только когда нужно. Claude Code: `STANDARDS.md` отдельно, грузится по триггеру. Экономит контекст. Применимо к spec — не одним 50KB файлом, а модулями.

### K. Контейнер-isolation для дешёвой модели

Опциональный Tier 2: дешёвая модель работает в isolated workspace (Docker), не может случайно `rm -rf $HOME`. Cap blast radius.

---

## Часть C — Ответы на 5 открытых вопросов

**Q1. agent_teams параллелизм + watcher.** Bottleneck не токены — upstream rate-limit. Comfortable: **3-5 параллельных coding subagent'ов на волну**. Watcher на 429 + backoff, не на token-budget. Опыт subbrain: 14 PR параллельно → 6 регрессий (43%). Параллельность требует обязательного post-merge audit.

**Q2. Где хранить контракты.** Source of truth = **`.md` рядом с кодом** (`docs/tasks/<feature>.md` или `specs/`). Memory/Subbrain — индекс активных контрактов + cross-session continuity, не источник правды. Issue-трекер опционально для людей.

**Q3. RLM max iter.** Dynamic: trivial=2, standard=5, complex=8. **Hard cap 10**. Сигнал плохой формулировки = **3 итерации medium issue подряд от критика → стоп, эскалация replan**.

**Q4. Verifier — другая модель или та же в чистом контексте?** **Та же в чистом контексте** (отдельный subagent spawn). Cross-model handoff = разные соглашения о форматах + потери. Holy rule: **writer ≠ runner**.

**Q5. Smoke-сценарии — кто пишет.** Trio:
- Claude в плане → acceptance criteria + «как проверить» (high-level)
- Реализатор → дописывает edge-case smoke своего модуля
- Verifier → **запускает**, не пишет.

---

## Часть D — Research findings (что брать готовое, где gap)

### Что точно НЕ изобретать

| Слой | Чем закрыть | URL |
|---|---|---|
| Spec-формат артефактов | OpenSpec (brownfield, delta-marked) или Spec Kit (greenfield) | github.com/Fission-AI/OpenSpec, github.com/github/spec-kit |
| Cross-tool baseline | **AGENTS.md** standard (Linux Foundation, Sourcegraph/OpenAI/Google/Cursor) | thepromptshelf.dev/blog/agents-md-vs-claude-md |
| Skill методология | superpowers (178k⭐) или addyosmani/agent-skills (27.8k⭐) — **только описать паттерн `fresh-subagent verifier`**, не как dep | github.com/obra/superpowers |
| Pre-commit | Biome + Ultracite preset + Lefthook | biomejs.dev, ultracite.ai |
| Result/Pattern | ts-pattern + neverthrow (НЕ effect-ts — overkill для weak model) | github.com/gvergnaud/ts-pattern |
| Critic loop | LangGraph supervisor pattern документирован, но достаточно описать паттерн | blog.langchain.com/reflection-agents |
| Schema enforcement | Anthropic SDK tool-calling нативно (BAML только если cross-language) | docs.anthropic.com |
| Observability | Helicone (one-line) tier 1, OTel GenAI semconv tier 2 | helicone.ai, opentelemetry.io/docs/specs/semconv/gen-ai |

### Где gap — наш spec даёт ценность

1. **Tool-agnostic doc** — superpowers Claude-only, OpenSpec artefact-only. Никто не описывает паттерн «работает в Claude Code + Cursor + Aider + raw-CLI Kimi одновременно».
2. **Weak-model-explicit guardrails** — индустрия пишет "AI agent" без дифференциации сильный/слабый. Никто не говорит «вот baseline для слабой модели».
3. **Tiered onboarding (5min/1hr/1day)** — рынок поляризован: либо zero-config, либо full-methodology.
4. **Pre-commit preset для AI-code** — нет `eslint-config-ai-strict` или `biome-ai`. Spec может опубликовать как companion configs.
5. **Multi-tier teamlead/implementer/critic паттерн** — формализован только в академических agent-swarm papers, не в practitioner doc'ах.

---

## Часть E — Финальные decisions (от юзера)

1. **Два спека:** `universal-spec.md` (shareable, polyglot, tool-agnostic) + `personal-subbrain-spec.md` (specific to subbrain repo).
2. **OpenSpec формат:** только формат `.md`-артефактов (`openspec/changes/<feature>/{proposal.md, design.md, tasks.md}`), без CLI. Конвенция папок, не зависимость.
3. **superpowers:** только описать паттерн `fresh-subagent verifier with isolated context`, не подключать как dep.
4. **Tier'ы 0/1/2 — обязательны** в spec.
5. **Companion configs (biome.json, lefthook.yml, AGENTS.md template, pre-commit snippets) — в scope этой сессии**, кладём как готовые блоки внутри spec. Без npm publish (это backlog).

---

## Часть F — Mandate для RLM-синтеза

Из этого draft'а синтезировать **`docs/specs/universal-spec.md`** со следующими свойствами:

**Audience:** разработчик, который хочет дать своему AI-агенту (Claude Code / Cursor / Aider / raw Kimi-CLI / etc.) инструкцию «настрой минимально комфортный workflow в моём проекте». Не привязан к конкретному стеку, языку, тулчейну.

**Структура (обязательная):**
1. **TL;DR** — одной страницы intro, объясняющий философию (strong/weak split + rails + RLM) и tier-tableзу.
2. **Tier 0 — 5 минут baseline** — конкретные шаги, готовые snippets (AGENTS.md, biome.json, lefthook.yml). Юзер может copy-paste и пойти.
3. **Tier 1 — 1 час** — RLM-цикл паттерн, контракт-фолдер (формат OpenSpec), fresh-subagent verifier паттерн.
4. **Tier 2 — 1 день** — agent_teams волны, observability, cost watcher, container-isolation.
5. **Anti-patterns каталог** — отдельной секцией.
6. **Reasoning-state-loss recovery** — отдельной секцией с recovery table.
7. **Companion configs** — appendix с готовыми файлами.
8. **Что НЕ изобретать (links to upstream)** — appendix.

**Обязательные принципы синтеза:**
- Tool-agnostic. Не привязываться к Claude Code / Cursor / etc. Использовать generic terms ("agent", "harness", "subagent spawn").
- Weak-model-explicit. Везде где правило особенно важно для слабой модели — пометить `[WEAK]`. Где universal — `[U]`.
- Each tier должен быть **executable as written** — никаких «придумайте сами как».
- Length cap: ≤ 4000 слов в финальной spec. Если не лезет — выкидывать слабые куски, не размазывать.
- Не дублировать черновик дословно — переписывать с учётом research findings и decisions.
- Готовые snippets (biome.json, lefthook.yml, AGENTS.md template) — внутри fenced code blocks, ready-to-copy.

**Verify gate (obligatory acceptance criteria):**
- [ ] Spec mentions both strong и weak модель как разные роли с разными properties.
- [ ] Tier 0 / 1 / 2 структура присутствует и каждый tier executable.
- [ ] Reasoning-state-loss секция с recovery table присутствует.
- [ ] AGENTS.md (cross-tool standard), не только CLAUDE.md.
- [ ] Companion configs (Biome + Lefthook + minimal AGENTS.md) — в виде ready-to-copy snippets.
- [ ] Anti-patterns каталог отдельной секцией.
- [ ] Links to upstream (superpowers, OpenSpec, Helicone, OTel GenAI semconv) приведены.
- [ ] Length ≤ 4000 слов.
- [ ] Tool-agnostic terminology (нет hardcoded "Claude Code"/"Cursor" в основной части — только в footnote/appendix).

После universal-spec.md — второй проход RLM создаёт **`docs/specs/personal-subbrain-spec.md`**, накладывающий subbrain-specific детали поверх универсального (модели по ролям, paths, /task RLM skill, dispatch-task-subagent skill, NIM endpoint, MiniMax fallback, /usr/projects/subbrain layout). Формат: ссылки на universal sections + delta-overrides.
