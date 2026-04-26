import { randomUUID } from "crypto";
import type { MemoryDB } from "../../../db";
import type { RAGPipeline } from "../../../rag";
import type { RequestLogger } from "../../../lib/logger";

import { validateCategoryAndContent, validateExpiresAt } from "./validators";
import { findDuplicate, mergeContent, mergeTags, bumpConfidence } from "./dedupe";
import {
  computeStatus,
  validateSupersedes,
  applySupersedes,
  embedOrReuse,
  type WriteResult,
} from "./extractors-helpers";

export type { WriteResult } from "./extractors-helpers";

export interface WriteSharedArgs {
  category: string;
  content: string;
  tags: string;
  confidence: number;
  expires_at?: number | null;
  supersedes?: string[];
}

export interface WriteContextArgs extends WriteSharedArgs {}

export async function writeShared(
  memory: MemoryDB,
  rag: RAGPipeline,
  args: WriteSharedArgs,
  log: RequestLogger,
): Promise<WriteResult> {
  const v1 = validateCategoryAndContent("shared", args.category, args.content);
  if (!v1.ok) {
    log.warn("post", `writeShared rejected: ${v1.reason}`);
    return { ok: false, error: v1.reason };
  }
  const v2 = validateExpiresAt(args.category, args.expires_at);
  if (!v2.ok) {
    log.warn("post", `writeShared rejected: ${v2.reason}`);
    return { ok: false, error: v2.reason };
  }
  const supersedeIds = args.supersedes ?? [];
  if (supersedeIds.length > 0) {
    const v3 = validateSupersedes(memory, "shared", supersedeIds);
    if (!v3.ok) {
      log.warn("post", `writeShared rejected: ${v3.reason}`);
      return { ok: false, error: v3.reason };
    }
  }

  // supersedes → force insert + retire (skip dedupe-on-merge so we don't
  // collapse the new write into a row it's supposed to replace). Below, the
  // `if (dup.id)` branch is unreachable when supersedes.length > 0.
  const dup = supersedeIds.length > 0
    ? { id: null, source: null as null, vec: null, embedFailed: false }
    : await findDuplicate(memory, rag, "shared", args.category, args.content);

  if (dup.id) {
    const old = memory.getShared(dup.id);
    if (old) {
      try {
        const merged = mergeContent(old.content, args.content);
        const tags = mergeTags(old.tags, args.tags);
        const conf = bumpConfidence(old.confidence, args.confidence);
        const status = computeStatus(conf);
        memory.transaction(() => {
          memory.updateShared(dup.id!, {
            content: merged,
            tags,
            confidence: conf,
            status,
            ...(args.expires_at !== undefined ? { expires_at: args.expires_at } : {}),
          });
          if (dup.vec) memory.upsertEmbedding(dup.id!, "shared", dup.vec);
        });
        log.info(
          "post",
          `→ shared/${args.category} [merged ${dup.source}, conf ${conf.toFixed(2)}]: ${args.content.slice(0, 100)}`,
          { meta: { factId: dup.id, layer: "shared", category: args.category, merged: true, source: dup.source } },
        );
        return { ok: true, id: dup.id, status, merged: true };
      } catch (err) {
        const em = err instanceof Error ? err.message : String(err);
        log.error("post", `writeShared merge update failed: ${em}`);
        return { ok: false, error: em };
      }
    }
  }

  if (dup.embedFailed) {
    const em = dup.embedError ?? "embed_failed";
    log.warn("post", `writeShared embed failed: ${em}`);
    return { ok: false, error: em };
  }
  const id = randomUUID();
  const status = computeStatus(args.confidence);
  const clamped = Math.min(1, Math.max(0, args.confidence));

  const vec = await embedOrReuse(rag, args.content, dup.vec);
  if (!vec) {
    log.warn("post", `writeShared embed failed`);
    return { ok: false, error: "embed_failed" };
  }

  try {
    memory.transaction(() => {
      memory.insertShared(
        id,
        args.category,
        args.content,
        args.tags,
        "post-processing",
        { confidence: clamped, status },
      );
      memory.upsertEmbedding(id, "shared", vec);
      if (args.expires_at !== undefined && args.expires_at !== null) {
        memory.updateShared(id, { expires_at: args.expires_at });
      }
      if (supersedeIds.length > 0) {
        applySupersedes(memory, "shared", id, supersedeIds);
      }
    });
  } catch (err) {
    const em = err instanceof Error ? err.message : String(err);
    log.error("post", `writeShared transaction failed: ${em}`);
    return { ok: false, error: em };
  }

  log.info(
    "post",
    `→ shared/${args.category} [${status} ${clamped.toFixed(2)}]: ${args.content.slice(0, 100)}`,
    { meta: { factId: id, layer: "shared", category: args.category, status, confidence: clamped } },
  );
  return { ok: true, id, status };
}

export async function writeContext(
  memory: MemoryDB,
  rag: RAGPipeline,
  args: WriteContextArgs,
  requestId: string,
  log: RequestLogger,
  agentId: string | null = null,
): Promise<WriteResult> {
  const v1 = validateCategoryAndContent("context", args.category, args.content);
  if (!v1.ok) {
    log.warn("post", `writeContext rejected: ${v1.reason}`);
    return { ok: false, error: v1.reason };
  }
  const v2 = validateExpiresAt(args.category, args.expires_at);
  if (!v2.ok) {
    log.warn("post", `writeContext rejected: ${v2.reason}`);
    return { ok: false, error: v2.reason };
  }
  const supersedeIds = args.supersedes ?? [];
  if (supersedeIds.length > 0) {
    const v3 = validateSupersedes(memory, "context", supersedeIds);
    if (!v3.ok) {
      log.warn("post", `writeContext rejected: ${v3.reason}`);
      return { ok: false, error: v3.reason };
    }
  }

  // supersedes-skips-dedupe — see writeShared.
  const dup = supersedeIds.length > 0
    ? { id: null, source: null as null, vec: null, embedFailed: false }
    : await findDuplicate(memory, rag, "context", args.category, args.content);

  if (dup.id) {
    const old = memory.getContext(dup.id);
    if (old) {
      try {
        const merged = mergeContent(old.content, args.content);
        const tags = mergeTags(old.tags, args.tags);
        const conf = bumpConfidence(old.confidence, args.confidence);
        const status = computeStatus(conf);
        memory.transaction(() => {
          memory.updateContext(dup.id!, {
            content: merged,
            tags,
            confidence: conf,
            status,
            ...(args.expires_at !== undefined ? { expires_at: args.expires_at } : {}),
          });
          if (dup.vec) memory.upsertEmbedding(dup.id!, "context", dup.vec);
        });
        log.info(
          "post",
          `→ context/${args.category} [merged ${dup.source}, conf ${conf.toFixed(2)}]: ${args.content.slice(0, 100)}`,
          { meta: { factId: dup.id, layer: "context", category: args.category, merged: true, source: dup.source } },
        );
        return { ok: true, id: dup.id, status, merged: true };
      } catch (err) {
        const em = err instanceof Error ? err.message : String(err);
        log.error("post", `writeContext merge update failed: ${em}`);
        return { ok: false, error: em };
      }
    }
  }

  if (dup.embedFailed) {
    const em = dup.embedError ?? "embed_failed";
    log.warn("post", `writeContext embed failed: ${em}`);
    return { ok: false, error: em };
  }
  const id = randomUUID();
  const status = computeStatus(args.confidence);
  const clamped = Math.min(1, Math.max(0, args.confidence));

  const vec = await embedOrReuse(rag, args.content, dup.vec);
  if (!vec) {
    log.warn("post", `writeContext embed failed`);
    return { ok: false, error: "embed_failed" };
  }

  try {
    memory.transaction(() => {
      memory.insertContext(
        id,
        args.category,
        args.content,
        args.tags,
        [requestId],
        agentId ?? undefined,
        { confidence: clamped, status },
      );
      memory.upsertEmbedding(id, "context", vec);
      if (args.expires_at !== undefined && args.expires_at !== null) {
        memory.updateContext(id, { expires_at: args.expires_at });
      }
      if (supersedeIds.length > 0) {
        applySupersedes(memory, "context", id, supersedeIds);
      }
    });
  } catch (err) {
    const em = err instanceof Error ? err.message : String(err);
    log.error("post", `writeContext transaction failed: ${em}`);
    return { ok: false, error: em };
  }

  log.info(
    "post",
    `→ context/${args.category} [${status} ${clamped.toFixed(2)}]: ${args.content.slice(0, 100)}`,
    { meta: { factId: id, layer: "context", category: args.category, status, confidence: clamped } },
  );
  return { ok: true, id, status };
}
