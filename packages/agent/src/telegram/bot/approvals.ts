/**
 * Telegram inline-button approval surface.
 *
 * Sends approval prompts to the operator chat when pending rows are created,
 * and handles approve/deny callback queries.
 */
import type { ApprovalRepository, ApprovalRow } from "@subbrain/core/db";
import { logApprovalDecision } from "@subbrain/core/lib/approval-audit";
import { logger } from "@subbrain/core/lib/logger";
import type { Bot } from "grammy";

const log = logger.child("telegram");

export interface ApprovalHandlerDeps {
  approvalRepo: ApprovalRepository;
  db?: import("bun:sqlite").Database;
}

export function sendApprovalPrompt(bot: Bot, chatId: number, row: ApprovalRow): void {
  const text = buildPromptText(row);
  bot.api
    .sendMessage(chatId, text, {
      parse_mode: "MarkdownV2",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Approve", callback_data: `approve:${row.id}` },
            { text: "❌ Deny", callback_data: `deny:${row.id}` },
          ],
        ],
      },
    })
    .catch((err: unknown) => {
      log.error(`Send failed: ${err instanceof Error ? err.message : String(err)}`);
    });
}

export function registerApprovalCallbacks(bot: Bot, deps: ApprovalHandlerDeps): void {
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    if (!data.startsWith("approve:") && !data.startsWith("deny:")) return;

    const [action, id] = data.split(":");
    if (!id) return;

    const row = deps.approvalRepo.getById(id);
    if (!row || row.status !== "pending") {
      await ctx.answerCallbackQuery({ text: "Already resolved or not found" });
      return;
    }

    const status = action === "approve" ? "approved" : "denied";
    const nowSec = Math.floor(Date.now() / 1000);
    const changed = deps.approvalRepo.updateStatus(id, status, nowSec);

    if (changed === 0) {
      await ctx.answerCallbackQuery({ text: "Already resolved" });
      return;
    }

    log.info(`${action}d approval ${id} for ${row.tool_name}`);
    if (deps.db) {
      logApprovalDecision(deps.db, {
        approvalId: id,
        toolName: row.tool_name,
        status,
        requestedAt: row.requested_at,
        resolvedAt: nowSec,
      });
    }
    await ctx.answerCallbackQuery({ text: action === "approve" ? "Approved" : "Denied" });
    await ctx.editMessageText(buildResolvedText(row, action === "approve"), {
      parse_mode: "MarkdownV2",
    });
  });
}

function escapeMd(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
}

function buildPromptText(row: ApprovalRow): string {
  const lines = [
    "🔒 *Approval requested*",
    "",
    `Tool: \`${escapeMd(row.tool_name)}\``,
    `Args: \`${escapeMd(row.request_message.slice(0, 1000))}\``,
  ];
  return lines.join("\n");
}

function buildResolvedText(row: ApprovalRow, approved: boolean): string {
  const status = approved ? "✅ APPROVED" : "❌ DENIED";
  return `🔒 *Approval ${status}*\n\nTool: \`${escapeMd(row.tool_name)}\``;
}
