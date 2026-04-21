/**
 * Persistence helpers: dynamic-tool serialization and chat row writes.
 * Extracted from `index.ts` so the facade stays tiny.
 */
import { randomUUID } from "crypto";
import type { MemoryDB } from "../../db";
import { logger } from "../../lib/logger";
import {
  DynamicToolRegistry,
  type DynamicToolDef,
} from "./dynamic-tools";

const DYNAMIC_TOOLS_AGENT_ID = "dynamic_tools";

export function loadPersistedDynamicTools(
  memory: MemoryDB,
  registry: DynamicToolRegistry,
): void {
  try {
    const row = memory.db
      .query(
        "SELECT content FROM agent_memory WHERE agent_id = ? ORDER BY updated_at DESC LIMIT 1",
      )
      .get(DYNAMIC_TOOLS_AGENT_ID) as { content: string } | null;
    if (row?.content) {
      const defs: DynamicToolDef[] = JSON.parse(row.content);
      registry.load(defs);
      logger.info("agent-loop", `Loaded ${defs.length} persisted dynamic tools`);
    }
  } catch {
    // no persisted tools or parse error
  }
}

export function persistDynamicTools(
  memory: MemoryDB,
  registry: DynamicToolRegistry,
): void {
  const serialized = JSON.stringify(registry.serialize());
  const existing = memory.db
    .query("SELECT id FROM agent_memory WHERE agent_id = ? LIMIT 1")
    .get(DYNAMIC_TOOLS_AGENT_ID) as { id: string } | null;
  if (existing) {
    memory.db.run(
      "UPDATE agent_memory SET content = ?, updated_at = unixepoch() WHERE id = ?",
      [serialized, existing.id],
    );
  } else {
    memory.insertAgentMemory(
      randomUUID(),
      DYNAMIC_TOOLS_AGENT_ID,
      serialized,
      "dynamic,tools,registry",
    );
  }
}

export function persistToChat(
  memory: MemoryDB,
  sessionId: string,
  requestId: string,
  model: string,
  task: string,
  answer: string,
): void {
  const chatId = sessionId || `auto-${requestId}`;
  const chatSource = sessionId?.startsWith("auto-")
    ? "autonomous"
    : sessionId
    ? "web"
    : "autonomous";

  const existing = memory.getChat(chatId);
  if (!existing) {
    const datePrefix =
      chatSource === "autonomous"
        ? `[${new Date().toLocaleString("ru-RU", {
            day: "numeric",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
          })}] `
        : "";
    try {
      memory.createChat(
        chatId,
        `${datePrefix}${task.slice(0, 70)}`,
        model,
        chatSource,
      );
    } catch (err) {
      if (!String(err instanceof Error ? err.message : err).includes("UNIQUE")) {
        throw err;
      }
    }
    memory.appendChatMessage(chatId, "user", task);
  }

  if (answer) {
    memory.appendChatMessage(chatId, "assistant", answer, { model, requestId });
  }
}
