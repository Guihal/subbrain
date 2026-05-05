/**
 * Loads Layer 1 (focus) + shared memory and builds the seed context block
 * fed into the hippocampus before its agentic search.
 */
import type { MemoryDB, SharedRow } from "@subbrain/core/db";

export interface FocusSeed {
  focusEntries: Record<string, string>;
  sharedMemory: SharedRow[];
}

export function loadFocusSeed(memory: MemoryDB): FocusSeed {
  return {
    focusEntries: memory.getAllFocus(),
    sharedMemory: memory.getAllShared(),
  };
}

export function buildSeedContext(seed: FocusSeed): string {
  const parts: string[] = [];
  if (Object.keys(seed.focusEntries).length > 0) {
    parts.push("### Focus Directives");
    for (const [key, value] of Object.entries(seed.focusEntries)) {
      parts.push(`- **${key}:** ${value}`);
    }
  }
  if (seed.sharedMemory.length > 0) {
    parts.push("\n### Shared Memory (user facts)");
    for (const s of seed.sharedMemory) {
      parts.push(`- [${s.category}] ${s.content}`);
    }
  }
  return parts.join("\n");
}
