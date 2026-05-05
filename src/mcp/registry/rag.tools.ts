/**
 * RAG — гибридный поиск FTS5 + vector → RRF → rerank.
 */
import { type ToolRegistry, t } from "./tool-registry";

export function registerRagTools(registry: ToolRegistry): void {
  registry.register({
    name: "rag_search",
    description:
      "Hybrid RAG search: FTS5 + vector → RRF merge → rerank. Best for finding relevant context. Costs 1-2 RPM.",
    scope: "public",
    input: t.Object({
      query: t.String({ description: "Search query" }),
      layers: t.Optional(
        t.Array(t.Union([t.Literal("context"), t.Literal("archive"), t.Literal("shared")])),
      ),
      top_n: t.Optional(t.Number({ description: "Top N results after rerank (default: 5)" })),
      skip_rerank: t.Optional(t.Boolean()),
    }),
    handler: (args, ctx) =>
      ctx.executor.ragSearch(args.query, args.layers, args.top_n, args.skip_rerank, ctx.agentId),
  });
}
