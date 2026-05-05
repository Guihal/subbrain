/**
 * @subbrain/plugin-scheduled-blacklist
 *
 * Context-conditional plugin: registers only when agentMode === "scheduled".
 * Hides STATEFUL_CLIENT_CODE_TOOLS from the LLM tool list.
 *
 * Defense-in-depth: tool names absent from OpenAI tool list = LLM has no
 * signal to invoke them. Risk of LLM remembering exact name from training
 * data + bypass is acceptable.
 *
 * Background: ~/vault/RLM/Daily/2026-04-28.md — 27.04.2026 free-agent
 * fake-digest incident. See F-3b in docs/tasks/code-tools-poisoning-fix.md.
 */
import type { Plugin, ToolResult } from "@subbrain/plugin";
import type { AgentMode } from "../../src/pipeline/agent-loop/types";

export const STATEFUL_CLIENT_CODE_TOOLS: ReadonlySet<string> = new Set([
  "overdue_reminder",
  "silent_projects_check",
  "critical_clients_monitor",
  "client_followup_check",
]);

export function isHiddenInMode(name: string, mode: AgentMode): boolean {
  return mode === "scheduled" && STATEFUL_CLIENT_CODE_TOOLS.has(name);
}

interface Ctx {
  agentMode?: AgentMode;
}

export const scheduledBlacklistPlugin: Plugin = {
  name: "@subbrain/plugin-scheduled-blacklist",
  setup({ hooks }) {
    hooks.onToolBefore(async ({ toolName, ctx }) => {
      const mode = (ctx as Ctx)?.agentMode;
      if (mode === "scheduled" && STATEFUL_CLIENT_CODE_TOOLS.has(toolName)) {
        return {
          kind: "rejected" as const,
          error: {
            code: "focus_blocked",
            message: `Tool "${toolName}" is blocked in scheduled mode (stateful client code tool).`,
          },
        };
      }
    });
  },
};
