# P7 Web Rewrite — Design Phase

Дизайн-задача для Subbrain Web Rewrite. Outputs — статические HTML/CSS-моки, потом отдельной волной портируется в Nuxt 4 + Vue 3 + @nuxt/ui.

## Files

- [`00-master-spec.md`](./00-master-spec.md) — общий бриф: эстетика, цветовая палитра, типографика, density, mobile-fallback rules, IA, deliverable structure, все зафиксированные решения.
- [`backend-roadmap.md`](./backend-roadmap.md) — что нужно докрутить в бэкенде для P7. Разнесено по приоритетам, маркировка вида ✅ DONE / 🚧 WIP / 📋 ROADMAP / ➕ NEW. Связь с существующим Wave 2/3 backlog.
- [`tasks/`](./tasks/) — 9 декомпозированных пакетов, готовых к передаче Claude Code последовательно.

## Tasks order

Sequential. Foundation (`00-foundation.md`) обязательно первый — design tokens, base, components, mock-data shape, lobby. Без него остальные не могут начать.

После Foundation — 8 функциональных блоков (01-08), могут идти в любом порядке но рекомендованный по importance:

1. [`00-foundation.md`](./tasks/00-foundation.md) — design system foundation **(BLOCKING)**
2. [`01-talk-and-remember.md`](./tasks/01-talk-and-remember.md) — главный flow (chat + memory)
3. [`03-tasks-and-projects.md`](./tasks/03-tasks-and-projects.md) — центральная по фокусу юзера (4 tab + 2 pool + projects + auto-tracker)
4. [`02-delegate-and-autonomous.md`](./tasks/02-delegate-and-autonomous.md) — agents + pool + A2A
5. [`06-observe-and-debug.md`](./tasks/06-observe-and-debug.md) — observability
6. [`04-control-and-trust.md`](./tasks/04-control-and-trust.md) — approval + audit + rollback + confidence tuner
7. [`05-extend-and-customize.md`](./tasks/05-extend-and-customize.md) — plugins + MCP browser + code-tools
8. [`08-operations-and-housekeeping.md`](./tasks/08-operations-and-housekeeping.md) — system management
9. [`07-connections-and-integrations.md`](./tasks/07-connections-and-integrations.md) — TG + integrations

## Workflow

Аналогично работе с Kimi: каждый пакет передаётся Claude Code в свежей сессии с явной инструкцией прочитать `00-master-spec.md` + `tasks/00-foundation.md` перед стартом. После выполнения — review результата, потом следующий пакет.

Decision packet pattern для dispatch:

```
Read first:
- /usr/projects/subbrain/docs/design/p7-rewrite/00-master-spec.md
- /usr/projects/subbrain/docs/design/p7-rewrite/tasks/<NN>-<name>.md
- Existing artifacts в /usr/projects/subbrain/docs/design/p7-mockups/shared/ (if previous packets done)

Goal: produce HTML mockup as specified в task file.

Output destination:
/usr/projects/subbrain/docs/design/p7-mockups/<filename>.html

Acceptance: см. ## Acceptance criteria в task file.
```

После всех 9 пакетов — `DESIGN-NOTES.md` пишется отдельно (rationale + alternatives + Tailwind mapping). Можно как 10-й пакет.

## Status

- [x] Master spec finalized (`00-master-spec.md`)
- [x] Backend roadmap (`backend-roadmap.md`)
- [x] 9 task packets decomposed
- [ ] Task 00 (Foundation) dispatched
- [ ] Tasks 01-08 dispatched
- [ ] DESIGN-NOTES.md
- [ ] Visual review + sign-off
- [ ] Port to Nuxt (separate wave)
