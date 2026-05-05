/**
 * Thin wrapper over `context-compressor` for the agent loop.
 * Returns `true` when compression fired so callers can emit SSE events.
 */

import type { MemoryDB } from "@subbrain/core/db";
import type { ModelRouter } from "../../lib/model-router";
import type { Message } from "../../providers/types";
import { compressContext, shouldCompress } from "../context-compressor";

export async function maybeCompress(
  messages: Message[],
  router: ModelRouter,
  memory: MemoryDB,
): Promise<boolean> {
  if (!shouldCompress(messages)) return false;
  await compressContext(messages, router, memory);
  return true;
}

export { shouldCompress };
