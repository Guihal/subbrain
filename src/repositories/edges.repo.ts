/**
 * EdgeRepository — M-05 (mig 14). Thin pass-through over `EdgesTable`.
 * Mirrors the PR-27 layering rule: services / pipeline / routes go through
 * the repo; raw SQL stays in `src/db/tables/edges.ts`.
 *
 * `link` is the canonical hook used by the post-hippocampus extractor
 * (`linkRelated`) — it accepts the same shape as the inner `addEdge` so
 * future call sites stay grep-friendly. `getRelated` powers downstream
 * tickets (M-06 reflect promotion, M-09 cross-layer dedup).
 */
import type { Database } from "bun:sqlite";
import { EdgesTable } from "../db/tables/edges";
import type { EdgeKind, EdgeRow } from "../db/types";

export class EdgeRepository {
  private readonly edges: EdgesTable;

  constructor(db: Database) {
    this.edges = new EdgesTable(db);
  }

  link(
    srcId: string,
    srcLayer: string,
    dstId: string,
    dstLayer: string,
    kind: EdgeKind,
    weight: number = 1.0,
  ): boolean {
    return this.edges.addEdge(srcId, srcLayer, dstId, dstLayer, kind, weight);
  }

  getEdgesFromSrc = (srcId: string, srcLayer: string, kinds?: EdgeKind[]): EdgeRow[] =>
    this.edges.getEdgesFromSrc(srcId, srcLayer, kinds);

  getEdgesToDst = (dstId: string, dstLayer: string, kinds?: EdgeKind[]): EdgeRow[] =>
    this.edges.getEdgesToDst(dstId, dstLayer, kinds);

  getRelated = (
    id: string,
    layer: string,
    depth: 1 | 2 = 1,
    kinds?: EdgeKind[],
  ): { id: string; layer: string; kind: EdgeKind; weight: number }[] =>
    this.edges.getRelated(id, layer, depth, kinds);
}
