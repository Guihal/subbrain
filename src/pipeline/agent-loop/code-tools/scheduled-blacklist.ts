/**
 * Code tools that embed frozen client snapshots (имена клиентов, chat_ids,
 * overdue_hours, deadlines) and are unsafe to expose в scheduled mode where
 * no human verifies output. Hidden by `CodeToolRegistry.toToolDefs("scheduled")`.
 *
 * Defense-in-depth via tool-runner dispatch is intentionally NOT applied —
 * tool name absent from the OpenAI tool list = LLM has no signal to invoke it.
 * Risk of LLM remembering exact name from training data + bypass is acceptable.
 *
 * Background: `~/vault/RLM/Daily/2026-04-28.md` — diagnosis of the
 * 27.04.2026 free-agent fake-digest incident. See also F-3b in
 * `docs/tasks/code-tools-poisoning-fix.md`.
 */
import type { AgentMode } from "../types";

export const STATEFUL_CLIENT_CODE_TOOLS: ReadonlySet<string> = new Set([
  "overdue_reminder",
  "silent_projects_check",
  "critical_clients_monitor",
  "client_followup_check",
]);

export function isHiddenInMode(name: string, mode: AgentMode): boolean {
  return mode === "scheduled" && STATEFUL_CLIENT_CODE_TOOLS.has(name);
}
