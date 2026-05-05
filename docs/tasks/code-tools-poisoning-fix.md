# Code-tools poisoning fix (F-2 + F-3b + F-4)

Status: DONE (PR pending)

## Problem

27.04.2026 free-agent отправил TG-дайджест с фейковыми просрочками («Артём 18ч»,
«Александр QR 48ч»). Диагноз через `/task` (см. `~/vault/RLM/Daily/2026-04-28.md`):

- Hardcoded const'ы в `code_tools.overdue_reminder` + `silent_projects_check`
  + `critical_clients_monitor` + `client_followup_check` (created 22-24.04).
- Каждый автономный run возвращал frozen snapshot; free-agent + autonomous
  scheduler копировали в TG без верификации через `tg_read_chat`.
- `layer1_focus.no_repetitive_tg_spam` (set 25.04 юзером) injected в system
  prompt, но игнорился LLM — soft directive без hard-gate.

## Fixes

### F-4: tg_send_message hard-gate (scheduled-mode)

`packages/agent/packages/agent/packages/agent/src/mcp/registry/telegram.tools.ts`. Перед `tgSendMessage` handler читает
`layer1_focus.no_repetitive_tg_spam` через `executor.memoryDb.getFocusWithMeta`.
Trigger conditions (все одновременно):
- `ctx.agentMode === "scheduled"` (interactive runs пропускаются — у юзера
  прямой контроль).
- value non-empty (after trim).
- `Math.max(0, now - updated_at) < 7*86400` (clock-skew clamp).

Failure shape: `{success:false, error: "focus_blocked: ..."}`.

`agentMode` прокинут через `PublicToolContext.agentMode?` + `ToolRunnerDeps` +
`stepDeps/toolRunnerDeps` + run.ts/stream.ts callers.

### F-3b: Hide stateful client code-tools от scheduled mode

`packages/agent/packages/agent/packages/agent/packages/agent/src/pipeline/agent-loop/code-tools/scheduled-blacklist.ts` (NEW): Set с 4
именами (overdue_reminder/silent_projects_check/critical_clients_monitor/
client_followup_check). `CodeToolRegistry.toToolDefs(mode)` фильтрует по
`isHiddenInMode`. `agent-loop/index.ts:getAllTools(mode)` пропускает mode.

Defense-in-depth (mode-check в tool-runner dispatch) **не применён** — risk
LLM-bypass via remembered name acceptable; tool out of OpenAI tool list = LLM
не получает signal вызова.

### F-2: Hardcoded-facts validator в create_code_tool / edit_code_tool

`packages/agent/packages/agent/packages/agent/packages/agent/src/pipeline/agent-loop/code-tools/code-tool-validators.ts` (NEW). Объединяет
sandbox + facts проверки в `applyCodeToolGuards(code, name, log)`.

5 regex patterns (key-bound, low FP):
- `person-name`: prod name list (Артём/Артем/Александр/Дмитрий/Полина/Jorge/...)
- `tg-chat-id-literal`: `chat_id`/`chatId` key + 6+ digits.
- `overdue-hours-literal`: exact key `overdue_hours?:`.
- `ddmm-date-literal`: lastAction/lastContact/deadline/prepayment_date + DD.MM in value.
- `urgency-emoji-literal`: urgency/status/priority + colored circle emoji.

Severity: 0 → ok. 1 → warn (log, accept). ≥2 distinct labels → reject.

`code-mgmt.tools.ts` чисто потерял -19 lines (extracted SANDBOX_FORBIDDEN +
checkSandboxCompat) +4 (2× applyCodeToolGuards calls), net 165→150.

## Tests

- `tests/tg-send-spam-block.test.ts` — 6 cases (no directive ok, fresh blocks
  scheduled, expired allows, interactive bypass, empty value cleared, future
  updated_at still blocked).
- `tests/scheduled-tool-filter.test.ts` — 4 cases (interactive all, scheduled
  filtered, default===interactive, all-4-stateful blocked).
- `tests/code-tool-hardcoded-facts.test.ts` — 11 cases (severity matrix +
  applyCodeToolGuards integration + bare-numbers FP guard).

Total: 21 new tests. После: `bun test` → 833 pass / 0 fail; `bunx tsc --noEmit`
exit 0.

## Out of scope (manual operator on prod)

- F-1: `UPDATE code_tools SET enabled=0 WHERE name IN (...)` на проде (4 tools).
- F-6: purge contaminated `shared_memory` rows (preference #50cea049-...,
  context #0e1c642c-..., self-poisoning digest #f21b6038-...).
- F-5: M-08 forgetting curve audit для `layer3_archive` (отдельный PR).
- F-3a: free-agent prompt strengthening — F-3b structural и предпочтительный.

## Followups

- F-7 (proposed): integration test против реальной free-agent prompt path.
- F-8 (proposed): `metrics_log code_tool_call_count{tool, hardcoded_facts_detected}` в
  дашборде telemetry.
- Cross-check `tg_messages` 23-24.04 — был ли реально Артём «18ч просрочки» в
  момент создания tool (U-2 follow-up).
