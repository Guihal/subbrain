import type { MemoryStatus } from "../../db/index";
import type { InsertContextOpts, MemoryTable } from "../../db/tables/memory";

/**
 * Thin facades around `MemoryTable` (focus / context / archive / FTS / recent
 * helpers). Returns a flat object so `MemoryRepository` can `Object.assign`
 * the methods onto itself — preserves the existing public API while keeping
 * the repo class small.
 */
export function makeMemHelpers(mem: MemoryTable) {
  return {
    // Layer 1: focus
    getFocus: (key: string) => mem.getFocus(key),
    getFocusWithMeta: (key: string) => mem.getFocusWithMeta(key),
    setFocus: (key: string, value: string) => mem.setFocus(key, value),
    getAllFocus: () => mem.getAllFocus(),
    deleteFocus: (key: string) => mem.deleteFocus(key),

    // Layer 1 shadow (M-11, mig 16)
    getShadowFocus: (key: string) => mem.getShadowFocus(key),
    setShadowFocus: (key: string, value: string) => mem.setShadowFocus(key, value),
    getAllShadowFocus: () => mem.getAllShadowFocus(),
    clearShadowFocus: () => mem.clearShadowFocus(),

    // M-11 helper
    selectTopSharedForFocusRewrite: (limit: number) => mem.selectTopSharedForFocusRewrite(limit),

    // Layer 2: context
    insertContext: (
      id: string,
      title: string,
      content: string,
      tags?: string,
      derivedFrom?: string[],
      agentId?: string,
      opts?: InsertContextOpts,
    ) => mem.insertContext(id, title, content, tags, derivedFrom, agentId, opts),
    updateContext: (
      id: string,
      fields: {
        title?: string;
        content?: string;
        tags?: string;
        status?: MemoryStatus;
        confidence?: number | null;
        // MEM-6: post-hippocampus + night-cycle write paths.
        expires_at?: number | null;
        superseded_by?: string | null;
        derived_from?: string;
        // P3-2 (mig 17): bi-temporal columns.
        valid_from?: number | null;
        valid_to?: number | null;
        observed_at?: number | null;
      },
    ) => mem.updateContext(id, fields),
    getContext: (id: string) => mem.getContext(id),
    getContextMany: (
      ids: string[],
      opts?: { activeOnly?: boolean; notStale?: boolean; agentId?: string },
    ) => mem.getContextMany(ids, opts),
    listContext: (limit?: number, offset?: number) => mem.listContext(limit, offset),
    listContextActive: (limit?: number, offset?: number) => mem.listContextActive(limit, offset),
    countContext: () => mem.countContext(),
    getAllContext: () => mem.getAllContext(),
    deleteContext: (id: string) => mem.deleteContext(id),

    // Layer 3: archive (M-12 mig 15: confidence REAL [0..1] | null)
    insertArchive: (
      id: string,
      title: string,
      content: string,
      tags?: string,
      sourceRequestIds?: string[],
      confidence?: number | null,
      agentId?: string,
    ) => mem.insertArchive(id, title, content, tags, sourceRequestIds, confidence, agentId),
    getArchive: (id: string) => mem.getArchive(id),
    getArchiveMany: (ids: string[]) => mem.getArchiveMany(ids),
    listArchive: (limit?: number, offset?: number) => mem.listArchive(limit, offset),
    countArchive: () => mem.countArchive(),
    updateArchive: (
      id: string,
      fields: { title?: string; content?: string; tags?: string; confidence?: number | null },
    ) => mem.updateArchive(id, fields),
    deleteArchive: (id: string) => mem.deleteArchive(id),

    // FTS5
    searchContext: (
      query: string,
      limit?: number,
      opts?: { activeOnly?: boolean; notStale?: boolean; agentId?: string },
    ) => mem.searchContext(query, limit, opts),
    searchArchive: (query: string, limit?: number) => mem.searchArchive(query, limit),

    // M-06 reflection groups
    reflectGroups: (
      whitelist: readonly string[],
      minAccess: number,
      minGroup: number,
      maxGroups: number,
    ) => mem.reflectGroups(whitelist, minAccess, minGroup, maxGroups),

    // M-09 cross-layer + promote
    recentActiveContextForCrossLayer: (limit: number) =>
      mem.recentActiveContextForCrossLayer(limit),
    recentArchiveForCrossLayer: (limit: number) => mem.recentArchiveForCrossLayer(limit),
    archivePromoteCandidates: (minAccess: number, minConfidence: number, limit: number) =>
      mem.archivePromoteCandidates(minAccess, minConfidence, limit),
  };
}

export type MemHelpers = ReturnType<typeof makeMemHelpers>;
