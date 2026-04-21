/**
 * Direct-mode helper. The actual short-circuit happens upstream in
 * `routes/chat.ts` (header `X-Direct-Mode` or `router.isOverloaded`) — by the
 * time a request reaches AgentPipeline, it has already opted into the full
 * pipeline. This helper exists so callers/tests can ask the same question
 * without duplicating the predicate.
 */
import type { ModelRouter } from "../../../lib/model-router";

export function shouldUseDirectMode(
  headers: Record<string, string | undefined> | undefined,
  router: ModelRouter,
): boolean {
  return headers?.["x-direct-mode"] === "true" || router.isOverloaded;
}
