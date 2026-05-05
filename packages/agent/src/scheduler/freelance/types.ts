import type { FreelanceSource } from "@subbrain/core/db";

/** Raw item extracted from an exchange feed snapshot, before LLM scoring. */
export interface FeedItem {
  url: string;
  source: FreelanceSource;
  title: string;
  budget: number | null;
  deadlineDays: number | null;
  category: string | null;
  description: string;
}

export interface EvaluatedLead {
  score: number;
  reason: string;
}

export interface ScoutStatus {
  running: boolean;
  pausedUntil: Array<[string, number]>;
  lastRunAt: number | null;
  lastLeadAt: number | null;
  leadsToday: number;
}
