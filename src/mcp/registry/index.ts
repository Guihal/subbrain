/**
 * Фабрика реестра. Один вызов — и все тулы доступны через
 * REST, MCP JSON-RPC и агент-луп.
 */
import { ToolRegistry } from "./tool-registry";
import { registerMemoryTools } from "./memory.tools";
import { registerEmbedTools } from "./embed.tools";
import { registerLogTools } from "./log.tools";
import { registerRagTools } from "./rag.tools";
import { registerTelegramTools } from "./telegram.tools";
import { registerWebTools } from "./web.tools";
import { registerAgentMetaTools } from "./agent-meta.tools";
import { registerCodeMgmtTools } from "./code-mgmt.tools";

export { ToolRegistry } from "./tool-registry";
export type {
  ToolContext,
  ToolDef,
  ToolScope,
  ToolLog,
} from "./tool-registry";

/**
 * Строит реестр, регистрируя все тулы.
 * Процесс-синглтон: один реестр на приложение.
 */
export function buildRegistry(): ToolRegistry {
  const registry = new ToolRegistry();

  // Публичные (REST + MCP + агент)
  registerMemoryTools(registry);
  registerEmbedTools(registry);
  registerLogTools(registry);
  registerRagTools(registry);
  registerTelegramTools(registry);
  registerWebTools(registry);

  // Agent-only (только агент-луп)
  registerAgentMetaTools(registry);
  registerCodeMgmtTools(registry);

  return registry;
}
