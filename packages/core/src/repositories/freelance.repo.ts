/**
 * FreelanceRepository — PR 27 (LAYER-5). Wraps `FreelanceLeadsTable`.
 */
import type { Database } from "bun:sqlite";
import type { FreelanceLeadRow, FreelanceSource, FreelanceStatus } from "../db/index";
import { FreelanceLeadsTable } from "../db/tables/freelance-leads";

export class FreelanceRepository {
  private readonly freelance: FreelanceLeadsTable;

  constructor(db: Database) {
    this.freelance = new FreelanceLeadsTable(db);
  }

  insertFreelanceLead = (lead: {
    id: string;
    url: string;
    source: FreelanceSource;
    title: string;
    budget: number | null;
    score: number | null;
    reason: string | null;
  }): void => this.freelance.insert(lead);

  getFreelanceLead = (id: string): FreelanceLeadRow | null => this.freelance.getById(id);
  existsFreelanceByUrl = (url: string): boolean => this.freelance.existsByUrl(url);
  listFreelanceLeads = (opts: {
    status?: FreelanceStatus;
    limit: number;
    offset: number;
  }): { items: FreelanceLeadRow[]; total: number } => this.freelance.list(opts);
  updateFreelanceStatus = (id: string, status: FreelanceStatus): void =>
    this.freelance.updateStatus(id, status);
  countFreelanceLeadsSince = (ts: number): number => this.freelance.countLeadsSince(ts);
  lastFreelanceLeadAt = (): number | null => this.freelance.lastCreatedAt();
}
