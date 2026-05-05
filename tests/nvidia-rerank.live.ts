/**
 * Live smoke test for the NeMo Retriever reranking endpoint.
 *
 * Reranker is on a separate host from chat/embed (see src/providers/nvidia.ts).
 * This file is *.live.ts so `bun test` skips it; run manually when touching
 * rerank wiring:
 *
 *   bun run tests/nvidia-rerank.live.ts
 *
 * Requires NVIDIA_API_KEY. Passes iff the provider returns a properly-shaped
 * RerankResponse (results[].relevance_score) — the response-shape translation
 * from NVIDIA's {rankings:[{index,logit}]} must happen inside the provider,
 * not at the call site.
 */
import { NvidiaProvider } from "@subbrain/providers/nvidia";

const apiKey = process.env.NVIDIA_API_KEY;
const baseUrl = process.env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1";
if (!apiKey) {
  console.error("NVIDIA_API_KEY required");
  process.exit(1);
}

const p = new NvidiaProvider(baseUrl, apiKey);
const r = await p.rerank({
  model: "nvidia/rerank-qa-mistral-4b",
  query: "what is retrieval augmented generation",
  passages: [
    { text: "RAG combines retrieval with generation." },
    { text: "Cats purr when content." },
    { text: "Vector databases store embeddings." },
  ],
  top_n: 3,
});

if (!Array.isArray(r.results) || r.results.length === 0) {
  console.error("FAIL: empty or malformed results", r);
  process.exit(1);
}
for (const x of r.results) {
  if (typeof x.index !== "number" || typeof x.relevance_score !== "number") {
    console.error("FAIL: wrong result shape", x);
    process.exit(1);
  }
}

const sorted = [...r.results].sort((a, b) => b.relevance_score - a.relevance_score);
console.log("OK — rerank returned", r.results.length, "results");
console.log("Top:", sorted[0]);
