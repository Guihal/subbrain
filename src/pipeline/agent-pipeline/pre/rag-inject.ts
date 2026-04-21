/**
 * Hippocampus tool definitions + dispatcher: memory_search (FTS) and rag_search (hybrid+rerank).
 */
import type { MemoryDB } from "../../../db";
import type { RAGPipeline, RAGResult } from "../../../rag";
import type { Tool } from "../../../providers/types";

export const HIPPO_TOOLS: Tool[] = [
  {
    type: "function",
    function: {
      name: "memory_search",
      description:
        "FTS5 full-text search across memory layers. Fast, no RPM cost.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          layer: {
            type: "string",
            enum: ["context", "archive", "shared", "all"],
            description: "Which layer to search (default: all)",
          },
          limit: {
            type: "number",
            description: "Max results (default: 10)",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "rag_search",
      description:
        "Hybrid RAG: FTS5 + vector embeddings → rerank. More accurate but costs 1-2 RPM. Use when FTS is insufficient.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          top_n: {
            type: "number",
            description: "Top N results after rerank (default: 5)",
          },
        },
        required: ["query"],
      },
    },
  },
];

export async function executeHippoTool(
  name: string,
  args: Record<string, unknown>,
  memory: MemoryDB,
  rag: RAGPipeline,
): Promise<{ result: string; ragResults?: RAGResult[] }> {
  switch (name) {
    case "memory_search": {
      const query = args.query as string;
      const layer = (args.layer as string) || "all";
      const limit = (args.limit as number) || 10;
      const results: Record<string, unknown[]> = {};
      if (layer === "all" || layer === "context")
        results.context = memory.searchContext(query, limit);
      if (layer === "all" || layer === "archive")
        results.archive = memory.searchArchive(query, limit);
      if (layer === "all" || layer === "shared")
        results.shared = memory.searchShared(query, limit);
      return { result: JSON.stringify(results) };
    }
    case "rag_search": {
      const query = args.query as string;
      const topN = (args.top_n as number) || 5;
      try {
        const ragResults = await rag.search({ query, rerankTopN: topN });
        return { result: JSON.stringify(ragResults), ragResults };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { result: JSON.stringify({ error: msg }) };
      }
    }
    default:
      return { result: JSON.stringify({ error: `Unknown tool: ${name}` }) };
  }
}
