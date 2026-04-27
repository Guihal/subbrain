/**
 * Shared helpers for the memory tool split-folder.
 *
 * `embedWithTimeout` is the embed wrapper used by `write.ts`'s legacy
 * `writeSharedAtomic` fallback (see MEM-2 / M-FINAL2 in `index.ts`). The
 * 5s cap matches `tool-runner.ts` `embed_*` scope.
 */
import type { RAGPipeline } from "../../../rag";

export const EMBED_TIMEOUT_MS = 5000;

export async function embedWithTimeout(
  rag: RAGPipeline,
  content: string,
): Promise<Float32Array> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      rag.embedContent(content),
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error("embed_timeout")), EMBED_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
