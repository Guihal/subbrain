/**
 * Telegram chat tool handlers for the MCP executor.
 */
import type { MemoryDB } from "@subbrain/core/db";
import type { Userbot } from "../telegram/userbot";
import type { ToolResultV2 } from "./types";

function requireUserbot(userbot: Userbot | null): Userbot {
  if (!userbot?.isConnected()) {
    throw new Error("Telegram userbot not connected. Set TG_API_ID, TG_API_HASH, TG_SESSION.");
  }
  return userbot;
}

export async function tgListChats(userbot: Userbot | null, limit = 100): Promise<ToolResultV2> {
  try {
    const ub = requireUserbot(userbot);
    const chats = await ub.listChats(limit);
    return { kind: "success", data: chats };
  } catch (err) {
    return {
      kind: "error",
      error: { code: "unknown", message: err instanceof Error ? err.message : String(err) },
    };
  }
}

export async function tgReadChat(
  userbot: Userbot | null,
  chatId: string,
  limit = 50,
  offsetId?: number,
): Promise<ToolResultV2> {
  try {
    const ub = requireUserbot(userbot);
    const messages = await ub.readChat(chatId, limit, offsetId);
    return { kind: "success", data: messages };
  } catch (err) {
    return {
      kind: "error",
      error: { code: "unknown", message: err instanceof Error ? err.message : String(err) },
    };
  }
}

export async function tgSearchMessages(
  userbot: Userbot | null,
  query: string,
  limit = 30,
  chatId?: string,
): Promise<ToolResultV2> {
  try {
    const ub = requireUserbot(userbot);
    const messages = await ub.searchMessages(query, limit, chatId);
    return { kind: "success", data: messages };
  } catch (err) {
    return {
      kind: "error",
      error: { code: "unknown", message: err instanceof Error ? err.message : String(err) },
    };
  }
}

export function tgExcludeChat(
  memory: MemoryDB,
  chatId: string,
  chatTitle: string,
  reason = "private",
): ToolResultV2 {
  try {
    memory.excludeTgChat(chatId, chatTitle, reason);
    return { kind: "success", data: { excluded: chatId, chatTitle, reason } };
  } catch (err) {
    return {
      kind: "error",
      error: { code: "unknown", message: err instanceof Error ? err.message : String(err) },
    };
  }
}

export function tgIncludeChat(memory: MemoryDB, chatId: string): ToolResultV2 {
  try {
    memory.includeTgChat(chatId);
    return { kind: "success", data: { included: chatId } };
  } catch (err) {
    return {
      kind: "error",
      error: { code: "unknown", message: err instanceof Error ? err.message : String(err) },
    };
  }
}

export function tgListExcluded(memory: MemoryDB): ToolResultV2 {
  try {
    const excluded = memory.getExcludedTgChats();
    return { kind: "success", data: excluded };
  } catch (err) {
    return {
      kind: "error",
      error: { code: "unknown", message: err instanceof Error ? err.message : String(err) },
    };
  }
}

export function tgSetChatPolicy(
  memory: MemoryDB,
  chatId: string,
  policy: "full" | "scrubbed" | "metadata_only",
  updatedBy?: string,
): ToolResultV2 {
  try {
    memory.setChatPolicy(chatId, policy, updatedBy);
    return { kind: "success", data: { chatId, policy } };
  } catch (err) {
    return {
      kind: "error",
      error: { code: "unknown", message: err instanceof Error ? err.message : String(err) },
    };
  }
}
