/**
 * M-10: agent-only MCP curation tools (memory_link / memory_supersede /
 * memory_promote / memory_reflect). Domain logic split into its own module so
 * `memory-tools.ts` (already 470 LOC) stays untouched and the registry
 * (`memory.tools.ts`) keeps thin handler shims.
 *
 * All ops delegate to existing primitives:
 *   - `MemoryDB.linkEdge` (M-05)
 *   - `MemoryService.insertShared` (M-01, embed-first + transactional)
 *   - `runReflect` (M-06, CoALA episodic→semantic)
 *
 * No migration. No public REST exposure (privacy: raw memo curation must stay
 * agent-internal). Edge weight is hard-coded `1.0` to match the M-05
 * `linkRelated` extractor hook.
 */
import type { MemoryDB, EdgeKind } from "../../db";
import type { MemoryService } from "../../services/memory.service";
import type { RAGPipeline } from "../../rag";
import type { ModelRouter } from "../../lib/model-router";
import { runReflect, type ReflectResult } from "../../pipeline/night-cycle/steps/reflect";
import { logger } from "../../lib/logger";
import type { ToolResult } from "../types";

const log = logger.child("mcp.curation");

const CURATION_LAYERS = new Set(["context", "archive", "shared"] as const);

export type CurationLayer = "context" | "archive" | "shared";
export type SupersedeLayer = "context" | "shared";

export class MemoryCurationTools {
  constructor(
    private memory: MemoryDB,
    private getMemoryService: () => MemoryService | null,
    private getRag: () => RAGPipeline | null,
    private getRouter: () => ModelRouter | null,
  ) {}

  /**
   * Existence check by (id, layer). Returns true iff a row is found in the
   * given layer. Used as a soft sanity gate so memory_link / memory_supersede
   * surface a user-readable error instead of silently linking orphan edges.
   */
  private rowExists(id: string, layer: CurationLayer): boolean {
    if (layer === "context") return this.memory.getContext(id) !== null;
    if (layer === "archive") return this.memory.getArchive(id) !== null;
    return this.memory.getShared(id) !== null;
  }

  /** memory_link — typed edge between two memos. Idempotent on PK collision. */
  link(args: {
    src_id: string;
    src_layer: CurationLayer;
    dst_id: string;
    dst_layer: CurationLayer;
    kind: EdgeKind;
  }): ToolResult {
    if (!CURATION_LAYERS.has(args.src_layer) || !CURATION_LAYERS.has(args.dst_layer)) {
      return { success: false, error: "invalid layer" };
    }
    if (!this.rowExists(args.src_id, args.src_layer)) {
      return { success: false, error: `src not found: ${args.src_layer}/${args.src_id}` };
    }
    if (!this.rowExists(args.dst_id, args.dst_layer)) {
      return { success: false, error: `dst not found: ${args.dst_layer}/${args.dst_id}` };
    }
    const inserted = this.memory.linkEdge(
      args.src_id,
      args.src_layer,
      args.dst_id,
      args.dst_layer,
      args.kind,
      1.0,
    );
    log.info(
      `link ${args.src_layer}/${args.src_id.slice(0, 8)} -[${args.kind}]-> ${args.dst_layer}/${args.dst_id.slice(0, 8)} inserted=${inserted}`,
    );
    return { success: true, data: { linked: inserted } };
  }

  /**
   * memory_supersede — mark `old` as superseded by `new`. Updates
   * `superseded_by` column on the old row + writes audit edge
   * `kind='supersedes'`. Layers limited to context|shared (archive has no
   * superseded_by column per M-07 schema).
   */
  supersede(args: {
    old_id: string;
    old_layer: SupersedeLayer;
    new_id: string;
    new_layer: SupersedeLayer;
  }): ToolResult {
    if (args.old_id === args.new_id) {
      return { success: false, error: "self-supersede forbidden" };
    }
    if (!this.rowExists(args.old_id, args.old_layer)) {
      return { success: false, error: `old not found: ${args.old_layer}/${args.old_id}` };
    }
    if (!this.rowExists(args.new_id, args.new_layer)) {
      return { success: false, error: `new not found: ${args.new_layer}/${args.new_id}` };
    }
    if (args.old_layer === "shared") {
      this.memory.updateShared(args.old_id, { superseded_by: args.new_id });
    } else {
      this.memory.updateContext(args.old_id, { superseded_by: args.new_id });
    }
    this.memory.linkEdge(
      args.old_id,
      args.old_layer,
      args.new_id,
      args.new_layer,
      "supersedes",
      1.0,
    );
    log.info(
      `supersede ${args.old_layer}/${args.old_id.slice(0, 8)} -> ${args.new_layer}/${args.new_id.slice(0, 8)}`,
    );
    return { success: true };
  }

  /**
   * memory_promote — context → shared. Source row is preserved; caller may
   * follow up with memory_supersede or memory_delete for cleanup.
   */
  async promote(args: {
    src_id: string;
    src_layer: "context";
    target_layer: "shared";
  }): Promise<ToolResult> {
    const svc = this.getMemoryService();
    if (!svc) return { success: false, error: "memory service not configured" };
    const src = this.memory.getContext(args.src_id);
    if (!src) return { success: false, error: `src not found: context/${args.src_id}` };
    try {
      const newId = await svc.insertShared({
        category: src.title || "general",
        content: src.content,
        tags: src.tags,
        source: "promote",
        confidence: src.confidence ?? undefined,
        kind: "semantic",
      });
      this.memory.linkEdge(args.src_id, "context", newId, "shared", "derives", 1.0);
      log.info(
        `promote context/${args.src_id.slice(0, 8)} -> shared/${newId.slice(0, 8)}`,
      );
      return { success: true, data: { id: newId } };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `promote_failed: ${msg}` };
    }
  }

  /**
   * memory_reflect — manual trigger for the night-cycle reflect step (M-06).
   * Optional `category` filter narrows the top-N groups; `dryRun` previews
   * without inserting. Returns the same `ReflectResult` shape as the cron path.
   */
  async reflect(args: {
    category?: string;
    dryRun?: boolean;
  }): Promise<ToolResult> {
    const svc = this.getMemoryService();
    const rag = this.getRag();
    const router = this.getRouter();
    if (!svc) return { success: false, error: "memory service not configured" };
    if (!rag) return { success: false, error: "rag not configured" };
    if (!router) return { success: false, error: "router not configured" };
    try {
      const result: ReflectResult = await runReflect({
        memory: this.memory,
        memoryService: svc,
        rag,
        router,
        categoryFilter: args.category,
        dryRun: args.dryRun,
      });
      log.info(
        `reflect groups=${result.groups_examined} promoted=${result.facts_promoted} edges=${result.edges_created} failures=${result.llm_failures}`,
      );
      return { success: true, data: result };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `reflect_failed: ${msg}` };
    }
  }
}
