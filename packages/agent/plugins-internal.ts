/**
 * INTERNAL_PLUGINS — fixed-order registry of built-in plugins.
 *
 * Order matters: tool.execute.before hooks fire in registration order.
 *   1. code-tool-guards  — validate create/edit_code_tool body
 *   2. tg-gates          — block tg_send_message in scheduled mode
 *   3. scheduled-blacklist — hide stateful client code tools in scheduled mode
 *   4. freelance-scout   — shell re-export (no hooks in A2)
 *   5. approval-gate     — check requiresApproval, lookup approvals, insert pending
 */
import type { Plugin } from "@subbrain/plugin";
import { approvalGatePlugin } from "./plugins-internal/approval-gate";
import { codeToolGuardsPlugin } from "./plugins-internal/code-tool-guards";
import { freelanceScoutPlugin } from "./plugins-internal/freelance-scout";
import { scheduledBlacklistPlugin } from "./plugins-internal/scheduled-blacklist";
import { tgGatesPlugin } from "./plugins-internal/tg-gates";

export const INTERNAL_PLUGINS: readonly Plugin[] = [
  codeToolGuardsPlugin,
  tgGatesPlugin,
  scheduledBlacklistPlugin,
  freelanceScoutPlugin,
  approvalGatePlugin,
];
