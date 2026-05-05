import type { MemoryDB } from "../../db";
import type { ModelRouter } from "../../lib/model-router";
import type { AgentPipeline } from "../../pipeline";

/** Shared state passed to handler-registration helpers. */
export interface BotState {
  ownerChatId: number;
  memory: MemoryDB;
  pipeline: AgentPipeline;
  router: ModelRouter;
  chatMap: Map<number, string>;
  modelMap: Map<number, string>;
  getModel: (tgChatId: number) => string;
}
