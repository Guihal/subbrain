# Prompts Audit — subbrain

Инвентарь всех LLM-промптов в кодовой базе + найденные баги/запахи. Для обсуждения и правки.

Дата: 2026-04-21.

---

## 1. Persona preamble (инъектится в КАЖДЫЙ system prompt)

**Файл:** [src/lib/personas.ts:14-18](../src/lib/personas.ts#L14-L18)

```
Ты — часть системы «Subbrain» (Цифровая команда): ИИ-инфраструктура когнитивного расширения.
Твоя главная директива — делать жизнь пользователя лучше: помогать с задачами, предлагать идеи, решать проблемы, экономить время.
Пользователь общается на русском. Отвечай на том же языке, что и пользователь.
У тебя есть доступ к памяти (Layer 1-4): фокус, контекст, архив знаний, логи. Используй контекст, данный тебе в system prompt.
Текущая дата: ${new Date().toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" })}.
```

---

## 2. Personas (5 ролей)

**Файл:** [src/lib/personas.ts:20-96](../src/lib/personas.ts#L20-L96)

Teamlead / Coder / Critic / Generalist / Flash — все на русском, идут после preamble. У Teamlead дополнительно блок «⚡ Дефолт — общий сбор» с инструкцией звать `consult_specialists` на любом нетривиальном запросе.

---

## 3. Autonomous agent master prompt

**Файл:** [src/pipeline/agent-loop/system-prompt.ts:30-174](../src/pipeline/agent-loop/system-prompt.ts#L30-L174)

Самый большой промпт. Содержит:
- Режим «автономный агент», пинг каждые 15 мин, не жди ответа.
- Контекст о Дмитрии (22 года, стек, живёт с Никой).
- 9 правил (думай, не дублируй, сохраняй, уведомляй, интернет, общий сбор, done, не зацикливайся, бюджет).
- «🚀 Суперпроактивный режим (OpenClaw-стиль)» — сёрфинг по HN / Хабр / Upwork.
- Антипаттерны (❌ done при отсутствии задач).
- 🎲 Chaos Advisor — когда звать.
- Списки инструментов (memory, TG, Playwright, code_tools).

---

## 4. Agent loop nudges

**Файл:** [src/pipeline/agent-loop/step.ts:50-53](../src/pipeline/agent-loop/step.ts#L50-L53)

```
NUDGE_AFTER_CONTENT:
[Системная метка] Ты в автономном режиме — ответ текстом никто не увидит. Продолжай работу через инструменты. Когда действительно закончил — вызови `done` с резюме.

NUDGE_AFTER_EMPTY:
[Системная метка] Пустой ответ. Вызови инструмент или `done`, чтобы продолжить.
```

---

## 5. Budget note (каждый шаг автономного loop)

**Файл:** [src/pipeline/agent-loop/step.ts:75](../src/pipeline/agent-loop/step.ts#L75)

```
[Системная метка: Шаг {N}/{max} | Осталось вызовов: {N} | Контекст: ~{tok}/{MAX} токенов]
```

---

## 6. Arbitration room — 4 specialist prompts (EN)

**Файл:** [src/pipeline/arbitration-room.ts:43-52](../src/pipeline/arbitration-room.ts#L43-L52)

- **coder:** senior software engineer, practical, code quality.
- **critic:** code reviewer + security, edge cases, race conditions, challenge assumptions.
- **generalist:** senior tech lead, architectural balance, trade-offs, alternatives.
- **chaos:** contrarian Mistral, black swans, anti-consensus takes, provocative but grounded.

---

## 7. Arbitration room — TeamLead synthesis (RU)

**Файл:** [src/pipeline/arbitration-room.ts:301-316](../src/pipeline/arbitration-room.ts#L301-L316)

4 инструкции: консенсус / разногласия / решение / если критично — оба варианта / не упоминай агентов.

---

## 8. Hippocampus (pre) — executive summary (EN)

**Файл:** [src/pipeline/agent-pipeline/pre/exec-summary.ts:19-45](../src/pipeline/agent-pipeline/pre/exec-summary.ts#L19-L45)

Агентный цикл с `memory_search` + `rag_search`, макс 6 шагов / 25 сек. Выход ≤500 слов на русском (Контекст задачи / О пользователе / Активные проекты). Модель: `coder`, T=0.3.

---

## 9. Hippocampus (post) — write-path (EN)

**Файл:** [src/pipeline/agent-pipeline/post/hippocampus.ts:90-109](../src/pipeline/agent-pipeline/post/hippocampus.ts#L90-L109)

Модель `coder`, T=0.2. Ищет ~5 кандидат-фактов, проверяет через `memory_search`, пишет через `memory_write` (shared / context), вызывает `done`. Бюджет — 5 tool calls.

---

## 10. Context compressor (EN)

**Файл:** [src/pipeline/context-compressor.ts:27-41](../src/pipeline/context-compressor.ts#L27-L41)

Модель `flash`, T=0.2. Возвращает строгий JSON `{summary (300-500 слов русский), facts[]}`.

---

## 11-17. Night cycle (7 промптов)

**Файл:** [src/pipeline/night-cycle/steps.ts](../src/pipeline/night-cycle/steps.ts), модель `coder` (по умолчанию), T=0-0.3, англ.

- **11. PII scrub** (35-44) — Names→[NAME], Email→[EMAIL], Phone→[PHONE], Address→[ADDRESS], Card→[CARD], DOB→[DOB], Other→[REDACTED].
- **12. Translate** (76) — RU→EN, preserve technical terms + code.
- **13. Compress** (105-119) — JSON `{title, content, tags, skip}`.
- **14. Verify** (159-167) — JSON `{accurate, issues[]}`.
- **15. Dedup** (217-227) — JSON `{isDuplicate, duplicateOf, action: skip|merge|append}`.
- **16. Anti-patterns** (285-291) — markdown `## Anti-patterns detected` или `NONE`.
- **17. Resolve contradictions** (343-351) — JSON `{hasContradiction, resolution: keep_new|keep_old|merge, mergedContent}`.

---

## 18. Log tools compressor

**Файл:** [src/mcp/tools/log-tools.ts:54-56](../src/mcp/tools/log-tools.ts#L54-L56)

```
You are a compression assistant. Summarize the following conversation into a concise Markdown summary. Preserve key decisions, code snippets, and action items. Be brief but complete.
```

---

## 19. Freelance lead evaluator (RU)

**Файл:** [src/scheduler/freelance/evaluate.ts:4-6](../src/scheduler/freelance/evaluate.ts#L4-L6)

```
Оцени задачу по шкале 1-10, насколько быстро пара "разработчик + Claude Code" её закроет.
10 = час работы. 1 = невозможно / риски / домен, где Claude не силён.
Верни СТРОГО JSON без обёртки: {"score": <int 1-10>, "reason": "<одна короткая строка почему>"}.
```

---

## 20. Free agent task (RU)

**Файл:** [src/scheduler/free-agent.ts:19-41](../src/scheduler/free-agent.ts#L19-L41)

«Час свободы», 4 принципа (любопытство / самосовершенствование / полезность / связь), 6 идей-вдохновения, 4 safety-правила.

---

## 21. Chaos advisor (RU)

**Файл:** [src/mcp/registry/agent-meta.tools.ts:118-130](../src/mcp/registry/agent-meta.tools.ts#L118-L130)

Генератор 3 идей, модель `chaos`, T=0.9. Формат `N. [действие] — [почему]`.

---

# Баги и запахи (по убыванию критичности)

### 🔴 1. `personas.ts:18` — дата вычисляется один раз при загрузке модуля
`new Date()` внутри шаблонной строки на top-level ⇒ сервер, проработавший сутки, будет вчерашней датой во ВСЕХ system prompts. Все роли. Нужно вынести в функцию и звать на каждый запрос.

**Статус:** FIXED (см. ниже).

### 🔴 2. Три места хардкодят профиль «Дмитрий, 22, фрилансер, Ника, Nuxt/TS/PHP»
[system-prompt.ts:48-55](../src/pipeline/agent-loop/system-prompt.ts#L48-L55), [free-agent.ts:24](../src/scheduler/free-agent.ts#L24), [agent-meta.tools.ts:118](../src/mcp/registry/agent-meta.tools.ts#L118).

Протухнет возраст, сменится стек, разбегутся с Никой — чинить в трёх файлах. Вынеси в `src/lib/user-profile.ts` или тяни из `shared_memory` по категории `user`.

### 🟠 3. `system-prompt.ts:39` хардкодит «каждые 15 минут»
Реальный интервал — в `config.autonomous.intervalMinutes`. Меняешь конфиг — промпт врёт модели. Подставляй через шаблон.

### 🟠 4. `arbitration-room.ts:43-51` — специалисты на английском, синтез на русском
Модели возвращают англ-ответы, teamlead потом переводит — теряется нюанс. Либо все 5 на англ, либо все на рус.

### 🟠 5. `arbitration-room.ts:301-316` — противоречие в инструкциях
п.4 «покажи оба варианта», п.5 «формат как если бы ты один отвечал». Развести условия.

### 🟠 6. Агрессивный push на `consult_specialists` в teamlead + system-prompt
В автономном loop (100 шагов) это сожрёт Copilot RPM за час. Нужен порог сложности или квота сборов за сессию.

### 🟠 7. `system-prompt.ts:91` конфликтует с правилом 8
«Задач нет — НИКОГДА done» vs «3-5 попыток не дали — остановись». Нужен terminal-state: «если серф-раунд не дал находок — done».

### 🟡 8. `context-compressor.ts` использует `flash`
В night-cycle ты сам заменил flash на coder из-за reasoning-overhead (25с/вызов). В компрессоре то же самое. Переведи на `coder`.

### 🟡 9. `context-compressor.ts:171` — `summary.trim() === "(nothing notable)"` отбрасывает весь результат
Даже если `facts[]` не пустой — потеря фактов. Проверяй на `facts.length === 0 && summary === ...`.

### 🟡 10. PII scrub без whitelist'а кода
Модель может заредактить `class User`, `function getName()` в `[NAME]`. Добавь «preserve code identifiers, function/class/variable names».

### 🟡 11. Translate skip при `cyrillicRatio<0.1`
Пропускает смешанные RU/EN (50/50) и всё равно гонит через модель — ломает EN-термины.

### 🟡 12. Freelance evaluator — шкала 1-10 без якорей
Модель сожмёт в 6-8. Дай пример: «1=reverse-engineer закрытого API, 5=типовой Vue-компонент, 10=лендос за вечер».

### 🟡 13. `free-agent.ts:38` — safety rule ссылается на несуществующий flow
«Подтверждение через tg_send_message + ожидание ответа», но free-agent — fire-and-forget, ответ не ждётся. Уточни: «необратимые действия запрещены полностью».

### 🟡 14. `helpers.ts:43-51` — executiveSummary И rawMemoryBlock одновременно
Если оба есть — дублирование контекста. Выбирай один.

### 🟢 15. Hippocampus write-path (post) на английском
Но велит писать факты на языке обмена. Работает, но дешевле был бы сразу русский — стабильнее tool_calls в родном языке системы.

### 🟢 16. Chaos (T=0.9, max_tokens=1024) может резаться
При формате «1. — 2. — 3. —» иногда обрывается на полуслове. Добавь «ответ ≤700 токенов, 3 пункта обязательно».
