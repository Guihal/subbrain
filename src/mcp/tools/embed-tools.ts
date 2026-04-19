/**
 * Embedding and RAG search operations extracted from ToolExecutor.
 */
import type { ModelRouter } from "../../lib/model-router";
import type { MemoryDB } from "../../db";
import type { RAGPipeline } from "../../rag";
import type { ToolResult } from "../types";

export class EmbedTools {
  constructor(
    private memory: MemoryDB,
    private router: ModelRouter,
    private getRag: () => RAGPipeline | null,
  ) {}

  /**
   * Hybrid RAG search: FTS5 + vector → RRF → rerank.
   * Use this when RPM budget allows (costs 1-2 RPM).
   */
  async ragSearch(
    query: string,
    layers?: ("context" | "archive" | "shared")[],
    topN?: number,
    skipRerank?: boolean,
  ): Promise<ToolResult> {
    const rag = this.getRag();
    if (!rag) {
      // FTS-only fallback
      const n = topN || 10;
      const results: Record<string, unknown[]> = {};
      const target = layers?.[0] || "all";
      if (target === "all" || target === "context")
        results.context = this.memory.searchContext(query, n);
      if (target === "all" || target === "archive")
        results.archive = this.memory.searchArchive(query, n);
      if (target === "all" || target === "shared")
        results.shared = this.memory.searchShared(query, n);
      return { success: true, data: results };
    }

    const results = await rag.search({
      query,
      layers,
      rerankTopN: topN || 5,
      skipRerank,
    });

    return { success: true, data: results };
  }

  async embedText(
    text: string,
    type: "text" | "code" = "text",
  ): Promise<ToolResult> {
    const modelId =
      type === "code"
        ? "nvidia/nv-embedcode-7b-v1"
        : "nvidia/llama-3.2-nemoretriever-300m-embed-v1";

    const result = await this.router.scheduleRaw("normal", () =>
      this.router.raw.embed({
        model: modelId,
        input: [text],
        input_type: "passage",
      }),
    );

    return {
      success: true,
      data: {
        embedding: result.data[0].embedding,
        model: modelId,
        dim: result.data[0].embedding.length,
      },
    };
  }

  async embedSearch(
    query: string,
    topK?: number,
    layer?: string,
  ): Promise<ToolResult> {
    const embedResult = await this.router.scheduleRaw("normal", () =>
      this.router.raw.embed({
        model: "nvidia/llama-3.2-nemoretriever-300m-embed-v1",
        input: [query],
        input_type: "query",
      }),
    );

    const embedding = new Float32Array(embedResult.data[0].embedding);
    const results = this.memory.searchEmbeddings(embedding, topK || 10, layer);

    return { success: true, data: results };
  }

  async rerank(
    query: string,
    passages: string[],
    topN?: number,
  ): Promise<ToolResult> {
    const result = await this.router.scheduleRaw("normal", () =>
      this.router.raw.rerank({
        model: "nvidia/rerank-qa-mistral-4b",
        query,
        passages: passages.map((text) => ({ text })),
        top_n: topN || passages.length,
      }),
    );

    return { success: true, data: result.results };
  }
}
