// ─── Row Types for SQLite tables ──────────────────────────

export type MemoryStatus = "pending" | "active" | "rejected";

// M-07 (mig 12): persona/semantic/episodic/procedural enum on shared_memory.
// Persona = identity / profile / preference / relationship facts; gets +10%
// boost in RAG rerank. Semantic = factual knowledge (goal/skill/constraint/
// style). Episodic + procedural reserved for future writers (M-06 reflect
// step + code-tools). Stored as TEXT, validated via BEFORE INSERT/UPDATE
// triggers (SQLite ALTER cannot ADD CHECK in place).
export type MemoryKind = "persona" | "semantic" | "episodic" | "procedural";

// M-05 (mig 14): typed edges between memory rows (A-MEM lite Zettelkasten).
// `derives` — backfilled from layer2_context.derived_from JSON. `relates` —
// emitted by `linkRelated` extractors hook (top-3 vec neighbours per insert).
// `contradicts` / `supersedes` reserved for follow-up tickets (M-05.1/.2).
// Distinct from `MemoryKind` (shared_memory.kind, M-07). Validated by SQL
// CHECK (fresh table — no trigger needed since no ALTER ADD CHECK).
export type EdgeKind = "derives" | "relates" | "contradicts" | "supersedes";

// M-05 (mig 14): row shape for `memory_edges`. Composite PK
// (src_id, src_layer, dst_id, dst_layer, kind) — re-emitting the same edge
// is INSERT OR IGNORE silent no-op via `addEdge`.
export interface EdgeRow {
  src_id: string;
  src_layer: string;
  dst_id: string;
  dst_layer: string;
  kind: EdgeKind;
  weight: number;
  created_at: number;
}

export interface ContextRow {
  id: string;
  title: string;
  content: string;
  tags: string;
  derived_from: string;
  agent_id: string | null;
  created_at: number;
  updated_at: number;
  confidence: number | null;
  status: MemoryStatus;
  // MEM-6 (mig 9): unix-seconds expiry; null = no expiry. RAG/pre filter
  // out rows whose expires_at < now via the `notStale` opt.
  expires_at: number | null;
  // MEM-6 (mig 9): id of the row that replaced this one, or 'expired' when
  // the night cycle marks a row as past its expires_at.
  superseded_by: string | null;
  // M-02 (mig 10): unix-seconds timestamp of last RAG retrieval hit; NULL on
  // legacy rows that have never been retrieved. Populated by
  // MemoryRepository.bumpAccess after rerank. Same unit as created_at /
  // updated_at / expires_at — M-08 decay reads (now - last_accessed_at).
  last_accessed_at?: number | null;
  // M-02 (mig 10): cumulative popularity counter (NOT NULL DEFAULT 0).
  // Optional in TS for back-compat with older selects.
  access_count?: number;
  // M-03 (mig 13): popularity/importance score [0..1]. NOT NULL DEFAULT 0.5
  // in SQL; optional in TS so legacy selects without the column compile.
  // Reinforced by `bumpAccess`, decayed nightly by `decay-salience` step.
  salience?: number;
  // M-03 (mig 13): unix-seconds bookkeeping for the idempotent night-cycle
  // decay step. NULL on legacy rows; first decay run uses last_accessed_at
  // as proxy and then writes `now` here.
  last_decayed_at?: number | null;
  // P3-2 (mig 17): bi-temporal columns — user-world validity window + observation time.
  valid_from?: number | null;
  valid_to?: number | null;
  observed_at?: number | null;
}

export interface ArchiveRow {
  id: string;
  title: string;
  content: string;
  tags: string;
  source_request_ids: string;
  // M-12 (mig 15): unified with shared/context — REAL [0..1], NULL allowed.
  // Legacy 'HIGH' rows backfilled to 0.9, 'LOW' rows to 0.4.
  confidence: number | null;
  agent_id: string | null;
  created_at: number;
  updated_at: number;
  // M-02 (mig 10): see ContextRow comment.
  last_accessed_at?: number | null;
  access_count?: number;
  // M-03 (mig 13): see ContextRow comment.
  salience?: number;
  last_decayed_at?: number | null;
}

export interface LogRow {
  id: number;
  request_id: string;
  session_id: string;
  agent_id: string;
  role: string;
  content: string;
  token_count: number | null;
  created_at: number;
}

// W2-1: per-role aggregate row for `/v1/logs/stats`. Shape mirrors the
// hand-rolled SQL alias names the route used before the SoC migration so
// the response contract stays byte-identical.
export interface LogStatsRow {
  role: string;
  count: number;
  total_tokens: number | null;
  first_at: string;
  last_at: string;
}

export interface SharedRow {
  id: string;
  category: string;
  content: string;
  tags: string;
  source: string | null;
  created_at: number;
  updated_at: number;
  confidence: number | null;
  status: MemoryStatus;
  // MEM-6 (mig 9): unix-seconds expiry; null = no expiry. RAG/pre filter
  // out rows whose expires_at < now via the `notStale` opt.
  expires_at: number | null;
  // MEM-6 (mig 9): id of the row that replaced this one, or 'expired' when
  // the night cycle marks a row as past its expires_at.
  superseded_by: string | null;
  // M-02 (mig 10): see ContextRow comment.
  last_accessed_at?: number | null;
  access_count?: number;
  // M-03 (mig 13): see ContextRow comment.
  salience?: number;
  last_decayed_at?: number | null;
  // M-07 (mig 12): closed enum. NOT NULL DEFAULT 'semantic' in SQL — required
  // here. Persona rows get +10% boost in RAG rerank (`rag/pipeline.ts`).
  kind: MemoryKind;
  // P3-2 (mig 17): bi-temporal columns — user-world validity window + observation time.
  valid_from?: number | null;
  valid_to?: number | null;
  observed_at?: number | null;
}

export interface AgentMemRow {
  id: string;
  agent_id: string;
  content: string;
  tags: string;
  created_at: number;
  updated_at: number;
}

// P3-5 (mig 18): editable named text fragments scoped per role.
export interface BlockRow {
  id: string;
  owner_role: string;
  label: string;
  body: string;
  created_at: number;
  updated_at: number;
  version: number;
}

export interface FtsResult {
  id: string;
  title: string;
  tags: string;
  snippet: string;
  rank: number;
  created_at: number;
  updated_at: number;
  // M-07 (mig 12): only populated by `searchShared` (the only FTS source
  // whose underlying table carries the `kind` column). Optional so context /
  // archive search paths stay unchanged.
  kind?: string;
  // M-03 (mig 13): salience score [0..1]. Selected by FTS searchShared /
  // searchContext / searchArchive so the RAG rerank salience-boost step
  // (`rag/pipeline.ts:applySalienceBoost`) does not need an extra round-trip.
  // Optional for back-compat with the log layer (no salience column).
  salience?: number;
  // M-08 (no new mig): access columns (M-02, mig 10) threaded through FTS
  // SELECT lists so `applyForgettingCurve` in `rag/pipeline.ts` can read
  // them without a second round-trip. Optional — log layer has no columns.
  last_accessed_at?: number | null;
  access_count?: number;
}

export interface VecResult {
  id: string;
  layer: string;
  distance: number;
}

export interface ChatRow {
  id: string;
  title: string;
  model: string;
  source: string;
  kind: string;
  created_at: number;
  updated_at: number;
}

export interface ChatMessageRow {
  id: number;
  chat_id: string;
  role: string;
  content: string;
  reasoning: string | null;
  model: string | null;
  request_id: string | null;
  created_at: number;
}

export interface TgExcludedChatRow {
  chat_id: string;
  chat_title: string;
  reason: string;
  created_at: number;
}

export interface TgMessageRow {
  message_id: number;
  chat_id: string;
  chat_name: string;
  from_name: string;
  ts: number;
  text: string;
  created_at: number;
}

export interface TgSearchHit extends TgMessageRow {
  rank: number;
}

export type FreelanceSource = "fl.ru" | "kwork.ru" | "freelance.ru";
export type FreelanceStatus = "new" | "taken" | "rejected";

export interface FreelanceLeadRow {
  id: string;
  url: string;
  source: FreelanceSource;
  title: string;
  budget: number | null;
  score: number | null;
  reason: string | null;
  status: FreelanceStatus;
  created_at: number;
  updated_at: number;
}

// ─── Tasks (Phase 1 of tasks-vs-memory split) ────────────────────────
export type TaskScope = "global" | "autonomous" | "free-agent" | "freelance" | "tg";

export type TaskStatus = "open" | "in_progress" | "done" | "cancelled";

export interface TaskRow {
  id: string;
  title: string;
  description: string;
  scope: TaskScope;
  status: TaskStatus;
  priority: number;
  due_at: number | null;
  source: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

export interface SchedulerStateRow {
  key: string;
  value: string;
  updated_at: number;
}
