import type { MemoryDB } from "@subbrain/core/db";
import type { RequestLogger } from "@subbrain/core/lib/logger";
import type { ModelRouter } from "@subbrain/core/lib/model-router";
import type { ToolExecutor } from "../../../mcp";
import type { TaskMutationBudget, ToolRegistry } from "../../../mcp/registry";
import type { RAGPipeline } from "../../../rag";
import { bumpWriteCount, checkWriteCap, type WriteGuard } from "./cap-guard";
import { writeContext, writeShared } from "./extractors";
import { parseMemoryWriteArgs } from "./parse-write";

export interface ToolResult {
  result: string;
  finished: boolean;
  factsWritten: number;
  tasksAdded: number;
  searchCalls: number;
}

export async function processToolCall(args: {
  name: string;
  toolArgs: Record<string, unknown>;
  guard: WriteGuard;
  requestId: string;
  agentId: string | null;
  log: RequestLogger;
  memory: MemoryDB;
  rag: RAGPipeline;
  router: ModelRouter;
  executor: ToolExecutor;
  registry: ToolRegistry;
  taskBudget: TaskMutationBudget;
}): Promise<ToolResult> {
  const {
    name,
    toolArgs,
    guard,
    requestId,
    agentId,
    log,
    memory,
    rag,
    router,
    executor,
    registry,
    taskBudget,
  } = args;
  let result = "";
  let finished = false;
  let factsWritten = 0;
  let tasksAdded = 0;
  let searchCalls = 0;

  switch (name) {
    case "memory_search": {
      searchCalls++;
      const q = String(toolArgs.query || "");
      const layer = String(toolArgs.layer || "all");
      const limit = Number(toolArgs.limit) || 5;
      const hits: Record<string, unknown[]> = {};
      if (layer === "all" || layer === "context") {
        hits.context = memory.searchContext(q, limit, agentId ? { agentId } : undefined);
      }
      if (layer === "all" || layer === "shared") {
        hits.shared = memory.searchShared(q, limit);
      }
      result = JSON.stringify(hits);
      break;
    }
    case "memory_write": {
      const cap = checkWriteCap(guard, requestId, log);
      if (cap.blocked) {
        result = cap.result;
        break;
      }
      const parsed = parseMemoryWriteArgs(toolArgs);
      if (!parsed.ok) {
        result = JSON.stringify({ ok: false, error: parsed.error });
        break;
      }
      const wr =
        parsed.layer === "shared"
          ? await writeShared(memory, rag, router, parsed.args, log)
          : await writeContext(memory, rag, router, parsed.args, requestId, log, agentId);
      if (wr.ok) {
        factsWritten++;
        bumpWriteCount(guard);
      }
      result = JSON.stringify(wr);
      break;
    }
    case "task_add": {
      const out = await registry.callAsAgent("task_add", toolArgs, {
        executor,
        agentId,
        log,
        registry,
        router: null,
        room: null,
        dynamicTools: null,
        codeTools: null,
        taskBudget,
      });
      if (out.success) {
        tasksAdded++;
        const title = String(toolArgs.title || "").slice(0, 100);
        log.info("post", `→ task_add: ${title}`, {
          meta: { layer: "tasks", remaining: taskBudget.remaining },
        });
      } else {
        log.warn("post", `task_add rejected: ${out.error}`);
      }
      result = JSON.stringify(out);
      break;
    }
    case "done": {
      finished = true;
      result = JSON.stringify({ ok: true });
      break;
    }
    default:
      result = JSON.stringify({ error: `Unknown tool: ${name}` });
  }

  return { result, finished, factsWritten, tasksAdded, searchCalls };
}
