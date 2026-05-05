import type { MemoryDB } from "@subbrain/core/db";
import type { ToolResult } from "../../types";

export function readMemory(memory: MemoryDB, id: string, layer?: string): ToolResult {
  let data: unknown = null;

  if (!layer || layer === "context") data = memory.getContext(id);
  if (!data && (!layer || layer === "archive")) data = memory.getArchive(id);
  if (!data && (!layer || layer === "shared")) {
    data = memory.db.query("SELECT * FROM shared_memory WHERE id = ?").get(id);
  }
  if (!data && (!layer || layer === "agent")) {
    data = memory.db.query("SELECT * FROM agent_memory WHERE id = ?").get(id);
  }

  if (!data) return { success: false, error: "Not found" };
  return { success: true, data };
}
