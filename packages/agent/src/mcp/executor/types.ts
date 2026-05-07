import type { ApprovalRow, MemoryDB } from "@subbrain/core/db";
import type { ModelRouter } from "@subbrain/core/lib/model-router";
import type { CodeToolRegistry } from "../../pipeline/agent-loop/code-tools";
import type { ArbitrationRoom } from "../../pipeline/arbitration";
import type { RAGPipeline } from "../../rag";
import type { MemoryService } from "../../services/memory";
import type { Userbot } from "../../telegram/userbot";
import type { EmbedTools, LogTools, MemoryTools, TasksTools, WebTools } from "../tools/index";
import type { MemoryCurationTools } from "../tools/memory-curation-tools";

export type ExecutorState = {
  memory: MemoryDB;
  router: ModelRouter;
  rag: RAGPipeline | null;
  userbot: Userbot | null;
  botNotify: ((text: string) => Promise<void>) | null;
  approvalNotifier: ((row: ApprovalRow) => void) | null;
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
