/**
 * Embedding / rerank тулы. Делегируют в ToolExecutor.embedTools (NVIDIA).
 */
import { type ToolRegistry, t } from "./tool-registry";

export function registerEmbedTools(registry: ToolRegistry): void {
  registry.register({
    name: "embed_text",
    description: "Generate an embedding for text using NVIDIA embeddings.",
    scope: "public",
    input: t.Object({
      text: t.String(),
      model: t.Optional(
        t.Union([t.Literal("text"), t.Literal("code")], {
          description: "Embedding model (default: text)",
        }),
      ),
    }),
    handler: (args, ctx) => ctx.executor.embedTools.embedText(args.text, args.model || "text"),
  });

  registry.register({
    name: "embed_search",
    description: "Vector similarity search across memory embeddings.",
    scope: "public",
    input: t.Object({
      query: t.String(),
      top_k: t.Optional(t.Number()),
      layer: t.Optional(t.String()),
    }),
    handler: (args, ctx) => ctx.executor.embedTools.embedSearch(args.query, args.top_k, args.layer),
  });

  registry.register({
    name: "rerank",
    description: "Rerank passages by relevance to a query (NVIDIA reranker).",
    scope: "public",
    input: t.Object({
      query: t.String(),
      passages: t.Array(t.String()),
      top_n: t.Optional(t.Number()),
    }),
    handler: (args, ctx) => ctx.executor.embedTools.rerank(args.query, args.passages, args.top_n),
  });
}
