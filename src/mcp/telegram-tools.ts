/**
 * Telegram chat tool handlers for the MCP executor.
 */
import type { MemoryDB } from "../db";
import type { Userbot } from "../telegram/userbot";
import type { ToolResult } from "./types";

function requireUserbot(userbot: Userbot | null): Userbot {
  if (!userbot || !userbot.isConnected()) {
    throw new Error(
      "Telegram userbot not connected. Set TG_API_ID, TG_API_HASH, TG_SESSION.",
    );
  }
  return userbot;
}

export async function tgListChats(
  userbot: Userbot | null,
  limit = 100,
): Promise<ToolResult> {
  try {
    const ub = requireUserbot(userbot);
    const chats = await ub.listChats(limit);
    return { success: true, data: chats };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function tgReadChat(
  userbot: Userbot | null,
  chatId: string,
  limit = 50,
  offsetId?: number,
): Promise<ToolResult> {
  try {
    const ub = requireUserbot(userbot);
    const messages = await ub.readChat(chatId, limit, offsetId);
    return { success: true, data: messages };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function tgSearchMessages(
  userbot: Userbot | null,
  query: string,
  limit = 30,
  chatId?: string,
): Promise<ToolResult> {
  try {
    const ub = requireUserbot(userbot);
    const messages = await ub.searchMessages(query, limit, chatId);
    return { success: true, data: messages };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function tgExcludeChat(
  memory: MemoryDB,
  chatId: string,
  chatTitle: string,
  reason = "private",
): ToolResult {
  try {
    memory.excludeTgChat(chatId, chatTitle, reason);
    return { success: true, data: { excluded: chatId, chatTitle, reason } };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function tgIncludeChat(memory: MemoryDB, chatId: string): ToolResult {
  try {
    memory.includeTgChat(chatId);
    return { success: true, data: { included: chatId } };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function tgListExcluded(memory: MemoryDB): ToolResult {
  try {
    const excluded = memory.getExcludedTgChats();
    return { success: true, data: excluded };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
