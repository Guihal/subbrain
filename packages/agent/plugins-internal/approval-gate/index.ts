/**
 * @subbrain/plugin-approval-gate
 *
 * Plugin that registers a tool.execute.before hook checking requiresApproval.
 * If the tool is gated, looks up existing approvals by args_hash:
 *   - fresh approved row  → passthrough (undefined)
 *   - pending row         → denied "awaiting_approval"
 *   - denied row          → denied "approval_denied"
 *   - none / expired      → insert pending row, return "awaiting_approval"
 *
 * If resolveOperatorChat() returns null, short-circuits with
 * "approval_unavailable" without touching the DB.
 *
 * Order: registered AFTER auto-deny plugins (code-tool-guards, tg-gates,
 * scheduled-blacklist) so those still fire first.
 */

import type { ToolExecutor } from "@subbrain/agent/mcp/executor";
import {
  canonicalizeArgs,
  requiresApproval,
  resolveOperatorChat,
} from "@subbrain/agent/mcp/registry/approval-registry";
import type { AgentMode } from "@subbrain/agent/pipeline/agent-loop/types";
import { ApprovalsTable } from "@subbrain/core/db/tables/approvals";
import { logApprovalDecision } from "@subbrain/core/lib/approval-audit";
import { logger } from "@subbrain/core/lib/logger";
import type { Plugin, ToolResult } from "@subbrain/plugin";

const log = logger.child("approval-gate");
const APPROVAL_TTL_SEC = Number(process.env.APPROVAL_TTL_SEC ?? "900");

interface Ctx {
  executor?: ToolExecutor;
  agentMode?: AgentMode;
}

function isFresh(
  row: { requested_at: number; resolved_at: number | null },
  nowSec: number,
): boolean {
  const anchor = row.resolved_at ?? row.requested_at;
  return nowSec - anchor <= APPROVAL_TTL_SEC;
}

export const approvalGatePlugin: Plugin = {
  name: "@subbrain/plugin-approval-gate",
  setup({ hooks }) {
    hooks.onToolBefore(async ({ toolName, args, ctx }) => {
      const mode = (ctx as Ctx)?.agentMode;
      if (!requiresApproval(toolName, mode)) {
        return undefined;
      }

      const operatorChatId = resolveOperatorChat();
      if (operatorChatId === null) {
        return {
          kind: "denied" as const,
          error: {
            code: "approval_unavailable",
            message:
              "Approval operator not configured (APPROVAL_OPERATOR_CHAT_ID or TG_OWNER_CHAT_ID)",
          },
        } satisfies ToolResult;
      }

      const executor = (ctx as Ctx)?.executor;
      if (!executor) {
        return {
          kind: "denied" as const,
          error: {
            code: "approval_unavailable",
            message: "Tool executor not available in hook context",
          },
        } satisfies ToolResult;
      }

      const db = executor.memoryDb.db;
      const table = new ApprovalsTable(db);
      const argsHash = canonicalizeArgs(args);
      const nowSec = Math.floor(Date.now() / 1000);

      const row = table.getByToolAndHash(toolName, argsHash);

      if (row) {
        if (row.status === "approved" && isFresh(row, nowSec)) {
          return undefined;
        }
        if (row.status === "pending") {
          return {
            kind: "denied" as const,
            error: {
              code: "awaiting_approval",
              message: `Approval pending for ${toolName} (hash: ${argsHash})`,
            },
          } satisfies ToolResult;
        }
        if (row.status === "denied") {
          return {
            kind: "denied" as const,
            error: {
              code: "approval_denied",
              message: `Approval denied for ${toolName} (hash: ${argsHash})`,
            },
          } satisfies ToolResult;
        }
        // "expired" or stale approved → treat as no row
      }

      // No fresh approved row: insert pending and deny.
      const argsPreview = JSON.stringify(args).slice(0, 1000);
      try {
        const row = table.insert({
          tool_name: toolName,
          args_hash: argsHash,
          status: "pending",
          requested_at: nowSec,
          resolved_at: null,
          operator_chat_id: operatorChatId,
          request_message: `Auto-requested approval for ${toolName}\nArgs: ${argsPreview}`,
        });
        log.info(`Inserted pending approval for ${toolName}`, {
          meta: { args_hash: argsHash, id: row },
        });
        logApprovalDecision(db, {
          approvalId: row,
          toolName,
          status: "pending",
          requestedAt: nowSec,
          resolvedAt: null,
        });
        const notifier = executor?.approvalNotifier;
        if (notifier) {
          const inserted = table.getById(row);
          if (inserted) notifier(inserted);
        }
      } catch (e) {
        // UNIQUE partial index may race; if another pending row exists, treat as pending.
        const existing = table.getByToolAndHash(toolName, argsHash);
        if (existing && existing.status === "pending") {
          return {
            kind: "denied" as const,
            error: {
              code: "awaiting_approval",
              message: `Approval pending for ${toolName} (hash: ${argsHash})`,
            },
          } satisfies ToolResult;
        }
        throw e;
      }

      return {
        kind: "denied" as const,
        error: {
          code: "awaiting_approval",
          message: `Approval requested for ${toolName} (hash: ${argsHash})`,
        },
      } satisfies ToolResult;
    });
  },
};
