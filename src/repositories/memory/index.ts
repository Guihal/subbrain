/**
 * MemoryRepository — PR 27 (LAYER-5) + W3-2 (split).
 *
 * Owns Layer-1/2/3 memory tables + shared + agent + embeddings. Sits between
 * services (no raw SQL) and per-table classes in `src/db/tables/*`. `MemoryDB`
 * (thin facade) delegates memory methods here too — back-compat for
 * `scripts/seed.ts`, `audit-db.ts`, and tests that still hold a `MemoryDB`.
 *
 * Boundary: raw SQL stays in `db/tables/*` and inside this folder
 * (`access.ts` / `status.ts`). Services / routes / pipeline must not issue
 * SQL — enforced by `tests/layer-boundary.test.ts`.
 *
 * Cross-layer ops (shared+embedding, context+embedding) are exposed as
 * `insertSharedWithEmbedding` / `insertContextWithEmbedding` so callers get
 * atomicity via `this.transaction()`.
 */
import { Database } from "bun:sqlite";
import { MemoryTable } from "../../db/tables/memory";
import { SharedTable } from "../../db/tables/shared";
import type { MemoryStatus } from "../../db/types";
import { bumpAccess, decaySalience } from "./access";
import { listByStatus, setStatusSafe, setSupersededBy, type PendingLayer } from "./status";
import { makeMemHelpers, type MemHelpers } from "./mem-helpers";
import { makeSharedHelpers, type SharedHelpers } from "./shared-helpers";

export interface MemoryRepository extends MemHelpers, SharedHelpers {}

export class MemoryRepository {
  private readonly mem: MemoryTable;
  private readonly shared: SharedTable;

  constructor(private readonly db: Database) {
    this.mem = new MemoryTable(db);
    this.shared = new SharedTable(db);
    Object.assign(this, makeMemHelpers(this.mem), makeSharedHelpers(this.shared));
  }

  /** Escape hatch for transactional composition (embed+insert atomicity). */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ─── M-02 / M-03 (mig 10/13) — see access.ts for full doc ────
  bumpAccess(layer: "shared" | "context" | "archive", ids: string[]): void {
    bumpAccess(this.db, layer, ids);
  }

  decaySalience(layer: "shared" | "context" | "archive", now: number): number {
    return decaySalience(this.db, layer, now);
  }

  // ─── PR 22a/b — pending status helpers (status.ts) ───────────
  listByStatus(
    layer: PendingLayer,
    status: MemoryStatus,
    limit: number,
    offset: number,
  ) {
    return listByStatus(this.db, layer, status, limit, offset);
  }

  setStatusSafe(layer: PendingLayer, id: string, status: MemoryStatus) {
    return setStatusSafe(this.db, this.mem, this.shared, layer, id, status);
  }

  // ─── MEM-6 supersede helper (status.ts) ──────────────────────
  setSupersededBy(layer: "shared" | "context", id: string, by: string): void {
    setSupersededBy(this.mem, this.shared, layer, id, by);
  }
}
