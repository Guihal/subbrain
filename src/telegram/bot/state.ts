import type { MemoryDB } from "../../db";
import type { AgentPipeline } from "../../pipeline";
import type { ModelRouter } from "../../lib/model-router";

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
