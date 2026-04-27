/**
 * MemoryTable — orchestrator for layer1_focus, layer1_focus_shadow,
 * layer2_context, layer3_archive. Public API stable; SQL split into:
 * focus.ts (Layer 1 KV + shadow + selectTopSharedForFocusRewrite),
 * context.ts (Layer 2 CRUD), archive.ts (Layer 3 CRUD), search.ts (FTS5),
 * aggregations.ts (reflect / cross-layer / promote), helpers.ts (filters +
 * ALLOW maps).
 */
import { Database } from "bun:sqlite";
import type {
  ArchiveRow,
  ContextRow,
  FtsResult,
  MemoryStatus,
} from "../../types";
import * as focus from "./focus";
import * as context from "./context";
import * as archive from "./archive";
import * as search from "./search";
import * as agg from "./aggregations";
import { type InsertContextOpts } from "./helpers";

export type { InsertContextOpts } from "./helpers";

type CtxFields = {
  title?: string;
  content?: string;
  tags?: string;
  status?: MemoryStatus;
  confidence?: number | null;
  expires_at?: number | null;
  superseded_by?: string | null;
  derived_from?: string;
};
type ArcFields = {
  title?: string;
  content?: string;
  tags?: string;
  confidence?: number | null;
};
type ListOpts = { activeOnly?: boolean; notStale?: boolean; agentId?: string };

export class MemoryTable {
  constructor(public readonly db: Database) {}

  // Layer 1 Focus
  getFocus = (key: string) => focus.getFocus(this.db, key);
  getFocusWithMeta = (key: string) => focus.getFocusWithMeta(this.db, key);
  setFocus = (key: string, value: string) => focus.setFocus(this.db, key, value);
  getAllFocus = () => focus.getAllFocus(this.db);
  deleteFocus = (key: string) => focus.deleteFocus(this.db, key);

  // Layer 1 shadow (M-11, mig 16)
  getShadowFocus = (key: string) => focus.getShadowFocus(this.db, key);
  setShadowFocus = (key: string, value: string) => focus.setShadowFocus(this.db, key, value);
  getAllShadowFocus = () => focus.getAllShadowFocus(this.db);
  clearShadowFocus = () => focus.clearShadowFocus(this.db);
  selectTopSharedForFocusRewrite = (limit: number) =>
    focus.selectTopSharedForFocusRewrite(this.db, limit);

  // Layer 2 Context
  insertContext(
    id: string,
    title: string,
    content: string,
    tags: string = "",
    derivedFrom: string[] = [],
    agentId?: string,
    opts?: InsertContextOpts,
  ): void {
    context.insertContext(this.db, id, title, content, tags, derivedFrom, agentId, opts);
  }
  updateContext = (id: string, fields: CtxFields) =>
    context.updateContext(this.db, id, fields);
  getContext = (id: string): ContextRow | null => context.getContext(this.db, id);
  getContextMany = (ids: string[], opts?: ListOpts): ContextRow[] =>
    context.getContextMany(this.db, ids, opts);
  listContext = (limit?: number, offset?: number): ContextRow[] =>
    context.listContext(this.db, limit, offset);
  listContextActive = (limit?: number, offset?: number) =>
    context.listContextActive(this.db, limit, offset);
  countContext = (): number => context.countContext(this.db);
  deleteContext = (id: string): void => context.deleteContext(this.db, id);

  // Layer 3 Archive
  insertArchive(
    id: string,
    title: string,
    content: string,
    tags: string = "",
    sourceRequestIds: string[] = [],
    confidence: number | null = 0.9,
    agentId?: string,
  ): void {
    archive.insertArchive(this.db, id, title, content, tags, sourceRequestIds, confidence, agentId);
  }
  getArchive = (id: string): ArchiveRow | null => archive.getArchive(this.db, id);
  getArchiveMany = (ids: string[]): ArchiveRow[] => archive.getArchiveMany(this.db, ids);
  listArchive = (limit?: number, offset?: number): ArchiveRow[] =>
    archive.listArchive(this.db, limit, offset);
  countArchive = (): number => archive.countArchive(this.db);
  updateArchive = (id: string, fields: ArcFields): void =>
    archive.updateArchive(this.db, id, fields);
  deleteArchive = (id: string): void => archive.deleteArchive(this.db, id);

  // FTS5 Search
  searchContext = (query: string, limit?: number, opts?: ListOpts): FtsResult[] =>
    search.searchContext(this.db, query, limit, opts);
  searchArchive = (query: string, limit?: number): FtsResult[] =>
    search.searchArchive(this.db, query, limit);

  // Aggregations (night cycle)
  reflectGroups = (
    whitelist: readonly string[],
    minAccess: number,
    minGroup: number,
    maxGroups: number,
  ) => agg.reflectGroups(this.db, whitelist, minAccess, minGroup, maxGroups);
  recentActiveContextForCrossLayer = (limit: number) =>
    agg.recentActiveContextForCrossLayer(this.db, limit);
  recentArchiveForCrossLayer = (limit: number) =>
    agg.recentArchiveForCrossLayer(this.db, limit);
  archivePromoteCandidates = (minAccess: number, minConfidence: number, limit: number) =>
    agg.archivePromoteCandidates(this.db, minAccess, minConfidence, limit);
}
