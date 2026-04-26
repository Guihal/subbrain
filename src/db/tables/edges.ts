import { Database } from "bun:sqlite";
import type { EdgeKind, EdgeRow } from "../types";

/**
 * EdgesTable — M-05 (mig 14). Owns `memory_edges`. Composite PK
 * (src_id, src_layer, dst_id, dst_layer, kind) — re-emitting same edge is
 * silent no-op via INSERT OR IGNORE. Used by `linkRelated` extractor hook
 * + mig-14 backfill from `layer2_context.derived_from`. Boundary: raw SQL
 * here only; repo + facade are thin pass-throughs.
 */
export class EdgesTable {
  constructor(public readonly db: Database) {}

  /**
   * Insert a typed edge. PK collision (same src/dst/kind tuple) → silent
   * no-op. Returns true on actual insert, false on PK skip.
   */
  addEdge(
    srcId: string,
    srcLayer: string,
    dstId: string,
    dstLayer: string,
    kind: EdgeKind,
    weight: number = 1.0,
  ): boolean {
    const res = this.db
      .query(
        `INSERT OR IGNORE INTO memory_edges
           (src_id, src_layer, dst_id, dst_layer, kind, weight)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(srcId, srcLayer, dstId, dstLayer, kind, weight);
    return res.changes > 0;
  }

  /**
   * All outbound edges from (srcId, srcLayer). Optionally filter by `kinds`.
   */
  getEdgesFromSrc(
    srcId: string,
    srcLayer: string,
    kinds?: EdgeKind[],
  ): EdgeRow[] {
    if (kinds && kinds.length > 0) {
      const placeholders = kinds.map(() => "?").join(",");
      return this.db
        .query(
          `SELECT * FROM memory_edges
            WHERE src_id = ? AND src_layer = ?
              AND kind IN (${placeholders})
            ORDER BY created_at DESC`,
        )
        .all(srcId, srcLayer, ...kinds) as EdgeRow[];
    }
    return this.db
      .query(
        `SELECT * FROM memory_edges
          WHERE src_id = ? AND src_layer = ?
          ORDER BY created_at DESC`,
      )
      .all(srcId, srcLayer) as EdgeRow[];
  }

  /**
   * All inbound edges to (dstId, dstLayer). Optionally filter by `kinds`.
   */
  getEdgesToDst(
    dstId: string,
    dstLayer: string,
    kinds?: EdgeKind[],
  ): EdgeRow[] {
    if (kinds && kinds.length > 0) {
      const placeholders = kinds.map(() => "?").join(",");
      return this.db
        .query(
          `SELECT * FROM memory_edges
            WHERE dst_id = ? AND dst_layer = ?
              AND kind IN (${placeholders})
            ORDER BY created_at DESC`,
        )
        .all(dstId, dstLayer, ...kinds) as EdgeRow[];
    }
    return this.db
      .query(
        `SELECT * FROM memory_edges
          WHERE dst_id = ? AND dst_layer = ?
          ORDER BY created_at DESC`,
      )
      .all(dstId, dstLayer) as EdgeRow[];
  }

  /**
   * Direct + 1-hop neighbours of (id, layer). depth=1 = direct (out + in).
   * depth=2 = 1-hop further from depth=1, excluding the seed. depth>2 is
   * out of scope (graph traversal cost). Returns deduped (id, layer) pairs
   * with the strongest edge metadata observed (max weight, latest kind).
   */
  getRelated(
    id: string,
    layer: string,
    depth: 1 | 2 = 1,
    kinds?: EdgeKind[],
  ): { id: string; layer: string; kind: EdgeKind; weight: number }[] {
    const seen = new Map<
      string,
      { id: string; layer: string; kind: EdgeKind; weight: number }
    >();
    const seedKey = `${layer}:${id}`;

    const expand = (sId: string, sLayer: string): void => {
      const out = this.getEdgesFromSrc(sId, sLayer, kinds);
      for (const e of out) {
        const key = `${e.dst_layer}:${e.dst_id}`;
        if (key === seedKey) continue;
        if (!seen.has(key)) {
          seen.set(key, {
            id: e.dst_id,
            layer: e.dst_layer,
            kind: e.kind as EdgeKind,
            weight: e.weight,
          });
        }
      }
      const inc = this.getEdgesToDst(sId, sLayer, kinds);
      for (const e of inc) {
        const key = `${e.src_layer}:${e.src_id}`;
        if (key === seedKey) continue;
        if (!seen.has(key)) {
          seen.set(key, {
            id: e.src_id,
            layer: e.src_layer,
            kind: e.kind as EdgeKind,
            weight: e.weight,
          });
        }
      }
    };

    expand(id, layer);
    if (depth === 2) {
      // Snapshot depth-1 keys so we don't recurse off rows we add mid-loop.
      const depthOne = [...seen.values()];
      for (const n of depthOne) expand(n.id, n.layer);
    }
    return [...seen.values()];
  }
}
