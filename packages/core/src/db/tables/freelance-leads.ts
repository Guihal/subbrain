import type { Database } from "bun:sqlite";
import type { FreelanceLeadRow, FreelanceSource, FreelanceStatus } from "../types";
import { updateRow } from "./update-row";

const FREELANCE_LEADS_UPDATABLE = new Set<string>(["status"]);

export class FreelanceLeadsTable {
  constructor(public readonly db: Database) {}

  insert(lead: {
    id: string;
    url: string;
    source: FreelanceSource;
    title: string;
    budget: number | null;
    score: number | null;
    reason: string | null;
  }): void {
    this.db
      .query(
        `INSERT INTO freelance_leads (id, url, source, title, budget, score, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(lead.id, lead.url, lead.source, lead.title, lead.budget, lead.score, lead.reason);
  }

  getById(id: string): FreelanceLeadRow | null {
    return this.db
      .query("SELECT * FROM freelance_leads WHERE id = ?")
      .get(id) as FreelanceLeadRow | null;
  }

  existsByUrl(url: string): boolean {
    const row = this.db
      .query("SELECT 1 AS x FROM freelance_leads WHERE url = ? LIMIT 1")
      .get(url) as { x: number } | null;
    return row !== null;
  }

  list(opts: { status?: FreelanceStatus; limit: number; offset: number }): {
    items: FreelanceLeadRow[];
    total: number;
  } {
    if (opts.status) {
      const items = this.db
        .query(
          "SELECT * FROM freelance_leads WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?",
        )
        .all(opts.status, opts.limit, opts.offset) as FreelanceLeadRow[];
      const total = (
        this.db
          .query("SELECT COUNT(*) AS c FROM freelance_leads WHERE status = ?")
          .get(opts.status) as { c: number }
      ).c;
      return { items, total };
    }
    const items = this.db
      .query("SELECT * FROM freelance_leads ORDER BY created_at DESC LIMIT ? OFFSET ?")
      .all(opts.limit, opts.offset) as FreelanceLeadRow[];
    const total = (
      this.db.query("SELECT COUNT(*) AS c FROM freelance_leads").get() as {
        c: number;
      }
    ).c;
    return { items, total };
  }

  updateStatus(id: string, status: FreelanceStatus): void {
    updateRow(this.db, "freelance_leads", FREELANCE_LEADS_UPDATABLE, id, {
      status,
    });
  }

  countLeadsSince(ts: number): number {
    return (
      this.db.query("SELECT COUNT(*) AS c FROM freelance_leads WHERE created_at >= ?").get(ts) as {
        c: number;
      }
    ).c;
  }

  lastCreatedAt(): number | null {
    const row = this.db
      .query("SELECT created_at AS ts FROM freelance_leads ORDER BY created_at DESC LIMIT 1")
      .get() as { ts: number } | null;
    return row?.ts ?? null;
  }
}
