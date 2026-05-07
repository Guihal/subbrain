/**
 * Фабрика реестра. Один вызов — и все тулы доступны через
 * REST, MCP JSON-RPC и агент-луп.
 */

import { registerAgentMetaTools } from "./agent-meta.tools";
import { registerCodeMgmtTools } from "./code-mgmt.tools";
import { registerEmbedTools } from "./embed.tools";
import { registerLogTools } from "./log.tools";
import { registerMemoryTools } from "./memory.tools";
import { registerPoolTools } from "./pool.tools";
import { registerRagTools } from "./rag.tools";
import { registerReportTools } from "./report.tools";
import { registerTasksTools } from "./tasks.tools";
import { registerTelegramTools } from "./telegram.tools";
import { ToolRegistry } from "./tool-registry";
import { registerWebTools } from "./web.tools";

export type {
  AgentMode,
  AgentToolContext,
  PublicToolContext,
  TaskMutationBudget,
  ToolContext,
  ToolContextFor,
  ToolDef,
  ToolLog,
  ToolScope,
} from "./tool-registry";
export { SCHEDULED_HIDDEN_TOOLS, ToolRegistry } from "./tool-registry";

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
  registerReportTools(registry);

  // Agent-only (только агент-луп)
  registerAgentMetaTools(registry);
  registerCodeMgmtTools(registry);
  registerTasksTools(registry);
  registerPoolTools(registry);

  return registry;
}
