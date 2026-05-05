import type { Database } from "bun:sqlite";
import { ChatRepository } from "../repositories/chat.repo";
import { EdgeRepository } from "../repositories/edges.repo";
import { FreelanceRepository } from "../repositories/freelance.repo";
import { LogRepository } from "../repositories/log.repo";
import { MemoryRepository } from "../repositories/memory";
import { TelegramRepository } from "../repositories/telegram.repo";
import { migrate, openDatabase } from "./schema";
import { SchedulerStateTable } from "./tables/scheduler-state";
import { TasksTable, type UpsertResult } from "./tables/tasks";
import type { TgMessageInsert, TgSearchOpts } from "./tables/tg-messages";
import type { FreelanceSource, FreelanceStatus, TaskScope, TaskStatus } from "./types";

export { EdgeRepository } from "../repositories/edges.repo";

export { EdgesTable } from "./tables/edges";
export { InvalidTransitionError } from "./tables/task-transitions";
export type { UpsertResult } from "./tables/tasks";
export type { TgMessageInsert, TgSearchOpts } from "./tables/tg-messages";
export type {
  AgentMemRow,
  ArchiveRow,
  ChatMessageRow,
  ChatRow,
  ContextRow,
  EdgeKind,
  EdgeRow,
  FreelanceLeadRow,
  FreelanceSource,
  FreelanceStatus,
  FtsResult,
  LogRow,
  MemoryKind,
  MemoryStatus,
  SchedulerStateRow,
  SharedRow,
  TaskRow,
  TaskScope,
  TaskStatus,
  TgExcludedChatRow,
  TgMessageRow,
  TgSearchHit,
  VecResult,
} from "./types";

/**
 * MemoryDB — PR 27 (LAYER-5). Kept as a thin facade: all memory/chat/log/
 * tg/freelance work delegates to the repository layer. `scripts/seed.ts`,
 * `scripts/audit-db.ts`, a few routes, and legacy tests still hold a
 * `MemoryDB` handle, so the method surface is preserved 1:1.
 *
 * New code inside `src/services/` consumes repositories directly — see
 * `src/app/deps.ts` for the wiring and the PR 27 task file for rationale.
 * Grep-gate `tests/layer-boundary.test.ts` blocks raw SQL leaking back into
 * services/routes/pipeline.
 *
 * `tasks` and `scheduler_state` stay on the facade pending a PR 27+ split
 * (no service/route owner needs a narrower view yet).
 */
export class MemoryDB {
  db: Database;
  readonly memoryRepo: MemoryRepository;
  readonly chatRepo: ChatRepository;
  readonly logRepo: LogRepository;
  readonly telegramRepo: TelegramRepository;
  readonly freelanceRepo: FreelanceRepository;
  readonly edgesRepo: EdgeRepository;
  private _tasks: TasksTable;
  private _scheduler: SchedulerStateTable;

  constructor(path: string) {
    this.db = openDatabase(path);
    migrate(this.db);
    this.memoryRepo = new MemoryRepository(this.db);
    this.chatRepo = new ChatRepository(this.db);
    this.logRepo = new LogRepository(this.db);
    this.telegramRepo = new TelegramRepository(this.db);
    this.freelanceRepo = new FreelanceRepository(this.db);
    this.edgesRepo = new EdgeRepository(this.db);
    this._tasks = new TasksTable(this.db);
    this._scheduler = new SchedulerStateTable(this.db);
  }

  close(): void {
    this.db.close();
  }

  /**
   * H-5: encapsulated atomic composition. Use this from pipeline / routes
   * when you need to bundle several repo writes — keeps `memory.db` access
   * confined to db/* and tests/scripts. Returns the callback's result.
   */
  transaction<T>(fn: () => T): T {
    return this.memoryRepo.transaction(fn);
  }

  // ─── Layer 1: Focus ────────────────────────────────────────
  getFocus = (key: string) => this.memoryRepo.getFocus(key);
  getFocusWithMeta = (key: string) => this.memoryRepo.getFocusWithMeta(key);
  setFocus = (key: string, value: string) => this.memoryRepo.setFocus(key, value);
  getAllFocus = () => this.memoryRepo.getAllFocus();
  deleteFocus = (key: string) => this.memoryRepo.deleteFocus(key);

  // ─── Layer 1 shadow (M-11, mig 16) ─────────────────────────
  getShadowFocus = (key: string) => this.memoryRepo.getShadowFocus(key);
  setShadowFocus = (key: string, value: string) => this.memoryRepo.setShadowFocus(key, value);
  getAllShadowFocus = () => this.memoryRepo.getAllShadowFocus();
  clearShadowFocus = () => this.memoryRepo.clearShadowFocus();
  selectTopSharedForFocusRewrite = (limit: number) =>
    this.memoryRepo.selectTopSharedForFocusRewrite(limit);

  // ─── Layer 2: Context ──────────────────────────────────────
  insertContext = (
    id: string,
    title: string,
    content: string,
    tags?: string,
    derivedFrom?: string[],
    agentId?: string,
    opts?: import("./tables/memory").InsertContextOpts,
  ) => this.memoryRepo.insertContext(id, title, content, tags, derivedFrom, agentId, opts);
  updateContext = (
    id: string,
    fields: {
      title?: string;
      content?: string;
      tags?: string;
      status?: import("./types").MemoryStatus;
      confidence?: number | null;
      // MEM-6 (mig 9): expiry + supersede + derived_from union are write
      // paths used by the post-hippocampus + night-cycle. Surface here so the
      // facade matches the repo signature.
      expires_at?: number | null;
      superseded_by?: string | null;
      derived_from?: string;
    },
  ) => this.memoryRepo.updateContext(id, fields);
  getContext = (id: string) => this.memoryRepo.getContext(id);
  getContextMany = (
    ids: string[],
    opts?: { activeOnly?: boolean; notStale?: boolean; agentId?: string },
  ) => this.memoryRepo.getContextMany(ids, opts);
  listContext = (limit?: number, offset?: number) => this.memoryRepo.listContext(limit, offset);
  listContextActive = (limit?: number, offset?: number) =>
    this.memoryRepo.listContextActive(limit, offset);
  countContext = () => this.memoryRepo.countContext();
  deleteContext = (id: string) => this.memoryRepo.deleteContext(id);
  getAllContext = () => this.memoryRepo.getAllContext();
  /** PR-B janitor Phase A: delete expired rows in bulk. COUNT-before avoids FTS shadow-table inflating .changes. */
  deleteExpiredShared(nowSec: number): number {
    const c = (
      this.db
        .query(
          "SELECT COUNT(*) as c FROM shared_memory WHERE expires_at IS NOT NULL AND expires_at < ?",
        )
        .get(nowSec) as { c: number }
    ).c;
    if (c > 0)
      this.db
        .query("DELETE FROM shared_memory WHERE expires_at IS NOT NULL AND expires_at < ?")
        .run(nowSec);
    return c;
  }
  deleteExpiredContext(nowSec: number): number {
    const c = (
      this.db
        .query(
          "SELECT COUNT(*) as c FROM layer2_context WHERE expires_at IS NOT NULL AND expires_at < ?",
        )
        .get(nowSec) as { c: number }
    ).c;
    if (c > 0)
      this.db
        .query("DELETE FROM layer2_context WHERE expires_at IS NOT NULL AND expires_at < ?")
        .run(nowSec);
    return c;
  }

  // ─── Layer 3: Archive ──────────────────────────────────────
  // M-12 (mig 15): archive confidence unified to REAL [0..1] | null.
  insertArchive = (
    id: string,
    title: string,
    content: string,
    tags?: string,
    sourceRequestIds?: string[],
    confidence?: number | null,
    agentId?: string,
  ) =>
    this.memoryRepo.insertArchive(id, title, content, tags, sourceRequestIds, confidence, agentId);
  getArchive = (id: string) => this.memoryRepo.getArchive(id);
  getArchiveMany = (ids: string[]) => this.memoryRepo.getArchiveMany(ids);
  listArchive = (limit?: number, offset?: number) => this.memoryRepo.listArchive(limit, offset);
  countArchive = () => this.memoryRepo.countArchive();
  updateArchive = (
    id: string,
    fields: { title?: string; content?: string; tags?: string; confidence?: number | null },
  ) => this.memoryRepo.updateArchive(id, fields);
  deleteArchive = (id: string) => this.memoryRepo.deleteArchive(id);

  // ─── FTS5 Search (context + archive) ──────────────────────
  searchContext = (
    query: string,
    limit?: number,
    opts?: { activeOnly?: boolean; notStale?: boolean; agentId?: string },
  ) => this.memoryRepo.searchContext(query, limit, opts);
  searchArchive = (query: string, limit?: number) => this.memoryRepo.searchArchive(query, limit);

  // ─── Shared Memory ─────────────────────────────────────────
  insertShared = (
    id: string,
    category: string,
    content: string,
    tags?: string,
    source?: string,
    opts?: import("./tables/shared").InsertSharedOpts,
  ) => this.memoryRepo.insertShared(id, category, content, tags, source, opts);
  getAllShared = () => this.memoryRepo.getAllShared();
  listShared = (
    limit?: number,
    offset?: number,
    category?: string,
    kind?: import("./types").MemoryKind,
  ) => this.memoryRepo.listShared(limit, offset, category, kind);
  listSharedActive = (limit?: number, offset?: number, category?: string) =>
    this.memoryRepo.listSharedActive(limit, offset, category);
  countShared = (category?: string, kind?: import("./types").MemoryKind) =>
    this.memoryRepo.countShared(category, kind);
  getShared = (id: string) => this.memoryRepo.getShared(id);
  getSharedMany = (ids: string[], opts?: { activeOnly?: boolean; notStale?: boolean }) =>
    this.memoryRepo.getSharedMany(ids, opts);
  getSharedByCategory = (category: string) => this.memoryRepo.getSharedByCategory(category);
  updateShared = (
    id: string,
    fields: {
      content?: string;
      tags?: string;
      category?: string;
      status?: import("./types").MemoryStatus;
      confidence?: number | null;
      // MEM-6 (mig 9): same as updateContext — surface so facade matches.
      expires_at?: number | null;
      superseded_by?: string | null;
      // M-07 (mig 12): persona/semantic re-classification on merge-update.
      kind?: import("./types").MemoryKind;
    },
  ) => this.memoryRepo.updateShared(id, fields);
  deleteShared = (id: string) => this.memoryRepo.deleteShared(id);

  // ─── Agent Memory ──────────────────────────────────────────
  insertAgentMemory = (id: string, agentId: string, content: string, tags?: string) =>
    this.memoryRepo.insertAgentMemory(id, agentId, content, tags);
  getAgentMemories = (agentId: string) => this.memoryRepo.getAgentMemories(agentId);
  // PR B-2: agent-loop/persist.ts uses these to round-trip the dynamic-tools blob.
  getLatestAgentMemoryByAgentId = (agentId: string) =>
    this.memoryRepo.getLatestAgentMemoryByAgentId(agentId);
  updateAgentMemoryContent = (id: string, content: string) =>
    this.memoryRepo.updateAgentMemoryContent(id, content);
  listAllAgentMemories = (limit?: number, offset?: number, agentId?: string) =>
    this.memoryRepo.listAllAgentMemories(limit, offset, agentId);
  countAgentMemories = (agentId?: string) => this.memoryRepo.countAgentMemories(agentId);
  listAgentIds = () => this.memoryRepo.listAgentIds();
  getAgentMemory = (id: string) => this.memoryRepo.getAgentMemory(id);
  updateAgentMemory = (id: string, fields: { content?: string; tags?: string }) =>
    this.memoryRepo.updateAgentMemory(id, fields);
  deleteAgentMemory = (id: string) => this.memoryRepo.deleteAgentMemory(id);

  // ─── FTS5 + Vector Search (shared) ─────────────────────────
  searchShared = (
    query: string,
    limit?: number,
    opts?: { activeOnly?: boolean; notStale?: boolean },
  ) => this.memoryRepo.searchShared(query, limit, opts);
  // MEM-6: facade for repo.setSupersededBy — used by night-cycle dedup.
  setSupersededBy = (layer: "shared" | "context", id: string, by: string) =>
    this.memoryRepo.setSupersededBy(layer, id, by);
  upsertEmbedding = (id: string, layer: string, embedding: Float32Array) =>
    this.memoryRepo.upsertEmbedding(id, layer, embedding);
  searchEmbeddings = (embedding: Float32Array, limit?: number, layer?: string) =>
    this.memoryRepo.searchEmbeddings(embedding, limit, layer);
  deleteEmbedding = (id: string) => this.memoryRepo.deleteEmbedding(id);
  // M-09: bulk-fetch raw vectors for cross-layer cosine in JS.
  getEmbeddingsByIds = (layer: string, ids: string[]) =>
    this.memoryRepo.getEmbeddingsByIds(layer, ids);

  // ─── Pending approval (PR 22b) — back-compat facade ───────
  listPending = (layer: "shared" | "context", opts: { limit: number; offset: number }) =>
    this.memoryRepo.listByStatus(layer, "pending", opts.limit, opts.offset);
  setStatus = (layer: "shared" | "context", id: string, status: import("./types").MemoryStatus) =>
    this.memoryRepo.setStatusSafe(layer, id, status);

  // ─── Chats ─────────────────────────────────────────────────
  createChat = (id: string, title: string, model: string, source?: string) =>
    this.chatRepo.createChat(id, title, model, source);
  getChat = (id: string) => this.chatRepo.getChat(id);
  listChats = (limit?: number, source?: string) => this.chatRepo.listChats(limit, source);
  updateChatTitle = (id: string, title: string) => this.chatRepo.updateChatTitle(id, title);
  updateChatModel = (id: string, model: string) => this.chatRepo.updateChatModel(id, model);
  updateChatTimestamp = (id: string) => this.chatRepo.updateChatTimestamp(id);
  deleteChat = (id: string) => this.chatRepo.deleteChat(id);

  // ─── Chat Messages ─────────────────────────────────────────
  appendChatMessage = (
    chatId: string,
    role: string,
    content: string,
    opts?: { reasoning?: string; model?: string; requestId?: string },
  ) => this.chatRepo.appendChatMessage(chatId, role, content, opts);
  getChatMessages = (chatId: string) => this.chatRepo.getChatMessages(chatId);

  // ─── Telegram Chat Exclusions ──────────────────────────────
  getExcludedTgChats = () => this.chatRepo.getExcludedTgChats();
  getExcludedTgChatIds = () => this.chatRepo.getExcludedTgChatIds();
  excludeTgChat = (chatId: string, chatTitle: string, reason?: string) =>
    this.chatRepo.excludeTgChat(chatId, chatTitle, reason);
  includeTgChat = (chatId: string) => this.chatRepo.includeTgChat(chatId);

  // ─── Layer 4: Raw Log ─────────────────────────────────────
  appendLog = (
    requestId: string,
    sessionId: string,
    agentId: string,
    role: string,
    content: string,
    tokenCount?: number,
  ) => this.logRepo.appendLog(requestId, sessionId, agentId, role, content, tokenCount);
  getLogsByRequest = (requestId: string) => this.logRepo.getLogsByRequest(requestId);
  getLogsBySession = (sessionId: string, limit?: number) =>
    this.logRepo.getLogsBySession(sessionId, limit);
  getLogsSince = (afterId: number, limit?: number) => this.logRepo.getLogsSince(afterId, limit);
  getLogsSinceTime = (sinceUnix: number, limit?: number) =>
    this.logRepo.getLogsSinceTime(sinceUnix, limit);
  listLog = (limit?: number, offset?: number, sessionId?: string) =>
    this.logRepo.listLog(limit, offset, sessionId);
  countLog = (sessionId?: string) => this.logRepo.countLog(sessionId);
  listLogSessions = (limit?: number) => this.logRepo.listLogSessions(limit);
  groupLogsBySession = (rows: import("./types").LogRow[]) => this.logRepo.groupLogsBySession(rows);
  // M-04 (mig 11): FTS5 search over Layer 4. Agent-only callers should reach
  // through `memory.logRepo.searchLog`; the facade keeps parity for
  // scripts/tests/legacy. PII-bearing — no public REST surface.
  searchLog = (query: string, opts?: import("./tables/log").SearchLogOpts) =>
    this.logRepo.searchLog(query, opts);

  // ─── Telegram Messages (FTS index) ─────────────────────────
  insertTgMessage = (msg: TgMessageInsert) => this.telegramRepo.insertTgMessage(msg);
  insertTgMessages = (rows: TgMessageInsert[]) => this.telegramRepo.insertTgMessages(rows);
  searchTgMessages = (opts: TgSearchOpts) => this.telegramRepo.searchTgMessages(opts);
  recentTgMessages = (chatId: string, limit?: number) =>
    this.telegramRepo.recentTgMessages(chatId, limit);
  countTgMessages = () => this.telegramRepo.countTgMessages();

  // ─── Freelance Leads ───────────────────────────────────────
  insertFreelanceLead = (lead: {
    id: string;
    url: string;
    source: FreelanceSource;
    title: string;
    budget: number | null;
    score: number | null;
    reason: string | null;
  }) => this.freelanceRepo.insertFreelanceLead(lead);
  getFreelanceLead = (id: string) => this.freelanceRepo.getFreelanceLead(id);
  existsFreelanceByUrl = (url: string) => this.freelanceRepo.existsFreelanceByUrl(url);
  listFreelanceLeads = (opts: { status?: FreelanceStatus; limit: number; offset: number }) =>
    this.freelanceRepo.listFreelanceLeads(opts);
  updateFreelanceStatus = (id: string, status: FreelanceStatus) =>
    this.freelanceRepo.updateFreelanceStatus(id, status);
  countFreelanceLeadsSince = (ts: number) => this.freelanceRepo.countFreelanceLeadsSince(ts);
  lastFreelanceLeadAt = () => this.freelanceRepo.lastFreelanceLeadAt();

  // ─── Tasks (lifecycle state) ───────────────────────────────
  insertTask = (task: {
    id: string;
    title: string;
    description?: string;
    scope: TaskScope;
    priority?: number;
    due_at?: number | null;
    source?: string | null;
  }) => this._tasks.insert(task);
  upsertTaskBySource = (
    source: string,
    fields: {
      scope: TaskScope;
      title: string;
      description?: string;
      priority?: number;
    },
    newId: string,
  ): UpsertResult => this._tasks.upsertBySource(source, fields, newId);
  getTask = (id: string) => this._tasks.get(id);
  listTasks = (opts: {
    scope?: TaskScope;
    status?: TaskStatus | "active";
    limit: number;
    offset: number;
  }) => this._tasks.list(opts);
  listTasksActive = (scope: TaskScope, limit: number) => this._tasks.listActive(scope, limit);
  countTasksActive = (scope: TaskScope) => this._tasks.countActive(scope);
  updateTask = (
    id: string,
    fields: {
      title?: string;
      description?: string;
      priority?: number;
      due_at?: number | null;
    },
  ) => this._tasks.update(id, fields);
  transitionTask = (id: string, to: TaskStatus) => this._tasks.transition(id, to);
  deleteTask = (id: string) => this._tasks.delete(id);
  deleteStaleTasksByStatus = (status: "open" | "in_progress", ageSec: number) =>
    this._tasks.deleteStaleByStatus(status, ageSec);
  /** PR-B janitor Phase D: delete done tasks whose completed_at is older than ageSec. */
  deleteDoneTasksOlderThan = (ageSec: number): number =>
    this.db
      .query("DELETE FROM tasks WHERE status = 'done' AND completed_at < unixepoch() - ?")
      .run(ageSec).changes;
  searchTaskDigests = (sinceUnix: number, limit: number, offset: number) =>
    this._tasks.searchTaskDigests(sinceUnix, limit, offset);
  countTaskDigestsSince = (sinceUnix: number) => this._tasks.countTaskDigestsSince(sinceUnix);
  listCompletedTasksSince = (opts: {
    scope?: TaskScope;
    sinceUnix: number;
    limit: number;
    offset: number;
  }) => this._tasks.listCompletedSince(opts);

  // ─── Memory edges (M-05, mig 14) ───────────────────────────
  // Thin facade over EdgeRepository — kept for parity with the other
  // memory layers; new pipeline code can hold edgesRepo directly.
  linkEdge = (
    srcId: string,
    srcLayer: string,
    dstId: string,
    dstLayer: string,
    kind: import("./types").EdgeKind,
    weight: number = 1.0,
  ) => this.edgesRepo.link(srcId, srcLayer, dstId, dstLayer, kind, weight);
  getEdgesFromSrc = (srcId: string, srcLayer: string, kinds?: import("./types").EdgeKind[]) =>
    this.edgesRepo.getEdgesFromSrc(srcId, srcLayer, kinds);
  getEdgesToDst = (dstId: string, dstLayer: string, kinds?: import("./types").EdgeKind[]) =>
    this.edgesRepo.getEdgesToDst(dstId, dstLayer, kinds);
  getRelated = (
    id: string,
    layer: string,
    depth: 1 | 2 = 1,
    kinds?: import("./types").EdgeKind[],
  ) => this.edgesRepo.getRelated(id, layer, depth, kinds);

  // ─── Scheduler state (ephemeral runtime flags) ─────────────
  getSchedulerState = (key: string) => this._scheduler.get(key);
  upsertSchedulerState = (key: string, value: string) => this._scheduler.upsert(key, value);
  deleteSchedulerState = (key: string) => this._scheduler.delete(key);
  tryAcquireSchedulerLock = (key: string, myId: string, staleSec: number) =>
    this._scheduler.tryAcquireLock(key, myId, staleSec);
  heartbeatSchedulerLock = (key: string, myId: string) => this._scheduler.heartbeat(key, myId);
}
