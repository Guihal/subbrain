import type { MemoryDB } from "../../db";
import type { ModelRouter } from "../../lib/model-router";
import type { RAGPipeline } from "../../rag";
import type { Userbot } from "../../telegram/userbot";
import type { CodeToolRegistry } from "../../pipeline/agent-loop/code-tools";
import type { ArbitrationRoom } from "../../pipeline/arbitration";
import type { MemoryService } from "../../services/memory";
import type {
  MemoryTools,
  EmbedTools,
  LogTools,
  WebTools,
  TasksTools,
} from "../tools/index";
import type { MemoryCurationTools } from "../tools/memory-curation-tools";

export type ExecutorState = {
  memory: MemoryDB;
  router: ModelRouter;
  rag: RAGPipeline | null;
  userbot: Userbot | null;
  botNotify: ((text: string) => Promise<void>) | null;
  codeTools: CodeToolRegistry | null;
  room: ArbitrationRoom | null;
  memoryService: MemoryService | null;
  memoryTools: MemoryTools;
  memoryCurationTools: MemoryCurationTools;
  embedTools: EmbedTools;
  logTools: LogTools;
  webTools: WebTools;
  tasksTools: TasksTools;
};
