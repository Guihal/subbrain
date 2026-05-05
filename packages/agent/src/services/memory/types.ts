import type { EdgeKind, MemoryKind, MemoryStatus } from "@subbrain/core/db";
import type { RequestLogger } from "@subbrain/core/lib/logger";
import type { ModelRouter } from "@subbrain/core/lib/model-router";

export type EdgeLayer = "context" | "shared" | "archive";

export interface RelatedEdge {
  id: string;
  layer: string;
  kind: EdgeKind;
  weight: number;
}

/**
 * M-13: optional post-hook deps for `linkRelated`. When set on the service,
 * every successful `insertShared`/`insertContext` schedules a best-effort
 * `linkRelated(...)` call (relates edges + A-MEM tag evolution + optional
 * contradiction detection). Test callers / scripts pass `null` to skip.
 */
export interface MemoryServiceLinkDeps {
  router: ModelRouter;
  log: RequestLogger;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
}

export type ListOpts = {
  limit: number;
  offset: number;
  q?: string;
  status?: MemoryStatus;
  category?: string;
  agentId?: string;
  sessionId?: string;
  // MEM-6: when true, hide superseded + expired rows from list/search results.
  // Admin UI default = false (sees full audit trail). RAG/pre never call into
  // this service, so default-false is safe.
  active?: boolean;
  // M-07 (mig 12): filter shared list by kind. Ignored on non-shared layers.
  kind?: MemoryKind;
};

export type InsertSharedInput = {
  category: string;
  content: string;
  tags?: string;
  source?: string;
  confidence?: number | null;
  status?: MemoryStatus;
  // M-07: optional kind override; default 'semantic' applies via SQL DEFAULT.
  kind?: MemoryKind;
  // PR-A: differential TTL; null = immortal.
  expires_at?: number | null;
};

export type InsertContextInput = {
  title: string;
  content: string;
  tags?: string;
  derivedFrom?: string[];
  agentId?: string;
  confidence?: number | null;
  status?: MemoryStatus;
  // PR-A: differential TTL; null = immortal.
  expires_at?: number | null;
};

export type UpdateSharedPatch = {
  content?: string;
  tags?: string;
  category?: string;
  status?: MemoryStatus;
  confidence?: number | null;
};

export type UpdateContextPatch = {
  title?: string;
  content?: string;
  tags?: string;
  status?: MemoryStatus;
  confidence?: number | null;
};

// M-12 (mig 15): unified with shared/context patches — confidence is
// REAL [0..1] | null. Route validates via TypeBox `t.Number({minimum:0,
// maximum:1})`; legacy "HIGH"/"LOW" strings are rejected at route boundary.
export type UpdateArchivePatch = {
  title?: string;
  content?: string;
  tags?: string;
  confidence?: number | null;
};

export type UpdateAgentPatch = { content?: string; tags?: string };

export type PendingLayer = "shared" | "context";
