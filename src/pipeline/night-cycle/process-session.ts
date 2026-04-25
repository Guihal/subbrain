/**
 * processSession (H-2 split from index.ts) — single-session pipeline:
 * scrub → translate → compress → verify → dedup → embed → archive.
 *
 * Returns `true` for terminal states (archived / deduped / skipped — not
 * worth retrying). Returns `false` only when scrub or translate yielded
 * `null`; the caller enqueues the session_id for the next cycle.
 */
import { randomUUID } from "crypto";
import type { LogRow, MemoryDB } from "../../db";
import type { ModelRouter } from "../../lib/model-router";
import type { RAGPipeline } from "../../rag";
import { logger } from "../../lib/logger";
import { type NightCycleResult, buildConversationText } from "./types";
import {
  scrubPII,
  translate,
  compress,
  verify,
  dedup,
} from "./steps";

const log = logger.child("night.session");

export async function processSession(
  deps: { memory: MemoryDB; router: ModelRouter; rag: RAGPipeline },
  sessionId: string,
  sessionLogs: LogRow[],
  label: string,
  result: NightCycleResult,
): Promise<boolean> {
  const { memory, router, rag } = deps;
  try {
    const conversationText = buildConversationText(sessionLogs);
    if (conversationText.length < 50) {
      log.debug(`${label} skipped (text < 50 chars)`);
      return true;
    }

    log.info(
      `[${label}] session=${sessionId.slice(0, 8)} chars=${conversationText.length}`,
    );

    const scrubbed = await scrubPII(conversationText, router);
    if (scrubbed === null) {
      log.warn(`[${label}] scrub_failed_skip session=${sessionId.slice(0, 8)}`);
      result.errors.push(`PII scrub failed: ${sessionId}`);
      return false;
    }

    const translated = await translate(scrubbed, router);
    if (translated === null) {
      log.warn(`[${label}] translate_failed_skip session=${sessionId.slice(0, 8)}`);
      result.errors.push(`Translate failed: ${sessionId}`);
      return false;
    }

    const requestIds = [...new Set(sessionLogs.map((l) => l.request_id))];
    const compressed = await compress(translated, requestIds, router);
    if (!compressed) {
      log.warn(`[${label}] compress returned empty — skipping`);
      return true;
    }

    const verified = await verify(compressed, translated, router);

    const isDuplicate = await dedup(verified, memory, router, rag);
    if (isDuplicate) {
      log.info(`[${label}] dedup hit — skipping`);
      return true;
    }

    const entryId = randomUUID();
    let vec: Float32Array;
    try {
      vec = await rag.embedContent(verified.content);
    } catch (err) {
      const msg = (err as Error).message;
      log.warn(`[${label}] archive_embed_fail_skip id=${entryId} reason=${msg}`);
      return true; // not a scrub failure; do not retry via queue
    }
    memory.db.transaction(() => {
      memory.insertArchive(
        entryId,
        verified.title,
        verified.content,
        verified.tags,
        verified.sourceRequestIds,
        verified.confidence,
        "night-cycle",
      );
      memory.upsertEmbedding(entryId, "archive", vec);
    })();
    result.archiveEntriesCreated++;
    log.info(`[${label}] archived "${verified.title.slice(0, 60)}"`);
    return true;
  } catch (err) {
    const msg = (err as Error).message;
    log.error(`[${label}] session ${sessionId.slice(0, 8)} failed: ${msg}`);
    result.errors.push(`Session ${sessionId}: ${msg}`);
    return true;
  }
}

