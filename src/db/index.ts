import { Database } from "bun:sqlite";
import { openDatabase, migrate } from "./schema";
import { MemoryTable } from "./tables/memory";
import { SharedTable } from "./tables/shared";
import { ChatsTable } from "./tables/chats";
import { LogsTable } from "./tables/logs";
import { TgMessagesTable, type TgMessageInsert, type TgSearchOpts } from "./tables/tg-messages";
import { FreelanceLeadsTable } from "./tables/freelance-leads";
import { TasksTable, type UpsertResult } from "./tables/tasks";
import { SchedulerStateTable } from "./tables/scheduler-state";
import type {
  FreelanceSource,
  FreelanceStatus,
  TaskScope,
  TaskStatus,
} from "./types";

export type {
  ContextRow,
  ArchiveRow,
  LogRow,
  SharedRow,
  AgentMemRow,
  FtsResult,
  VecResult,
  ChatRow,
  ChatMessageRow,
  TgExcludedChatRow,
  TgMessageRow,
  TgSearchHit,
  FreelanceLeadRow,
  FreelanceSource,
  FreelanceStatus,
  TaskRow,
  TaskScope,
  TaskStatus,
  SchedulerStateRow,
  MemoryStatus,
} from "./types";

export { InvalidTransitionError } from "./tables/task-transitions";
export type { UpsertResult } from "./tables/tasks";

export type { TgMessageInsert, TgSearchOpts } from "./tables/tg-messages";

export class MemoryDB {
  db: Database;
  private _mem: MemoryTable;
  private _shared: SharedTable;
  private _chats: ChatsTable;
  private _logs: LogsTable;
  private _tgmsg: TgMessagesTable;
  private _freelance: FreelanceLeadsTable;
  private _tasks: TasksTable;
  private _scheduler: SchedulerStateTable;

  constructor(path: string) {
    this.db = openDatabase(path);
    migrate(this.db);
    this._mem = new MemoryTable(this.db);
    this._shared = new SharedTable(this.db);
    this._chats = new ChatsTable(this.db);
    this._logs = new LogsTable(this.db);
    this._tgmsg = new TgMessagesTable(this.db);
    this._freelance = new FreelanceLeadsTable(this.db);
    this._tasks = new TasksTable(this.db);
    this._scheduler = new SchedulerStateTable(this.db);
  }

  close(): void {
    this.db.close();
  }

  // ─── Layer 1: Focus ────────────────────────────────────────
  getFocus = (key: string) => this._mem.getFocus(key);
  setFocus = (key: string, value: string) => this._mem.setFocus(key, value);
  getAllFocus = () => this._mem.getAllFocus();
  deleteFocus = (key: string) => this._mem.deleteFocus(key);

  // ─── Layer 2: Context ──────────────────────────────────────
  insertContext = (
    id: string,
    title: string,
    content: string,
    tags?: string,
    derivedFrom?: string[],
    agentId?: string,
    opts?: import("./tables/memory").InsertContextOpts,
  ) => this._mem.insertContext(id, title, content, tags, derivedFrom, agentId, opts);
  updateContext = (
    id: string,
    fields: {
      title?: string;
      content?: string;
      tags?: string;
      status?: import("./types").MemoryStatus;
      confidence?: number | null;
    },
  ) => this._mem.updateContext(id, fields);
  getContext = (id: string) => this._mem.getContext(id);
  getContextMany = (ids: string[], opts?: { activeOnly?: boolean }) =>
    this._mem.getContextMany(ids, opts);
  listContext = (limit?: number, offset?: number) => this._mem.listContext(limit, offset);
  countContext = () => this._mem.countContext();
  deleteContext = (id: string) => this._mem.deleteContext(id);

  // ─── Layer 3: Archive ──────────────────────────────────────
  insertArchive = (id: string, title: string, content: string, tags?: string, sourceRequestIds?: string[], confidence?: "HIGH" | "LOW", agentId?: string) =>
    this._mem.insertArchive(id, title, content, tags, sourceRequestIds, confidence, agentId);
  getArchive = (id: string) => this._mem.getArchive(id);
  getArchiveMany = (ids: string[]) => this._mem.getArchiveMany(ids);
  listArchive = (limit?: number, offset?: number) => this._mem.listArchive(limit, offset);
  countArchive = () => this._mem.countArchive();
  updateArchive = (id: string, fields: { title?: string; content?: string; tags?: string; confidence?: "HIGH" | "LOW" }) =>
    this._mem.updateArchive(id, fields);
  deleteArchive = (id: string) => this._mem.deleteArchive(id);

  // ─── FTS5 Search (context + archive) ──────────────────────
  searchContext = (query: string, limit?: number, opts?: { activeOnly?: boolean }) =>
    this._mem.searchContext(query, limit, opts);
  searchArchive = (query: string, limit?: number) => this._mem.searchArchive(query, limit);

  // ─── Shared Memory ─────────────────────────────────────────
  insertShared = (
    id: string,
    category: string,
    content: string,
    tags?: string,
    source?: string,
    opts?: import("./tables/shared").InsertSharedOpts,
  ) => this._shared.insertShared(id, category, content, tags, source, opts);
  getAllShared = () => this._shared.getAllShared();
  listShared = (limit?: number, offset?: number, category?: string) =>
    this._shared.listShared(limit, offset, category);
  countShared = (category?: string) => this._shared.countShared(category);
  getShared = (id: string) => this._shared.getShared(id);
  getSharedMany = (ids: string[], opts?: { activeOnly?: boolean }) =>
    this._shared.getSharedMany(ids, opts);
  getSharedByCategory = (category: string) => this._shared.getSharedByCategory(category);
  updateShared = (
    id: string,
    fields: {
      content?: string;
      tags?: string;
      category?: string;
      status?: import("./types").MemoryStatus;
      confidence?: number | null;
    },
  ) => this._shared.updateShared(id, fields);
  deleteShared = (id: string) => this._shared.deleteShared(id);

  // ─── Agent Memory ──────────────────────────────────────────
  insertAgentMemory = (id: string, agentId: string, content: string, tags?: string) =>
    this._shared.insertAgentMemory(id, agentId, content, tags);
  getAgentMemories = (agentId: string) => this._shared.getAgentMemories(agentId);
  listAllAgentMemories = (limit?: number, offset?: number, agentId?: string) =>
    this._shared.listAllAgentMemories(limit, offset, agentId);
  countAgentMemories = (agentId?: string) => this._shared.countAgentMemories(agentId);
  listAgentIds = () => this._shared.listAgentIds();
  getAgentMemory = (id: string) => this._shared.getAgentMemory(id);
  updateAgentMemory = (id: string, fields: { content?: string; tags?: string }) =>
    this._shared.updateAgentMemory(id, fields);
  deleteAgentMemory = (id: string) => this._shared.deleteAgentMemory(id);

  // ─── FTS5 + Vector Search (shared) ─────────────────────────
  searchShared = (query: string, limit?: number, opts?: { activeOnly?: boolean }) =>
    this._shared.searchShared(query, limit, opts);
  upsertEmbedding = (id: string, layer: string, embedding: Float32Array) =>
    this._shared.upsertEmbedding(id, layer, embedding);
  searchEmbeddings = (embedding: Float32Array, limit?: number, layer?: string) =>
    this._shared.searchEmbeddings(embedding, limit, layer);
  deleteEmbedding = (id: string) => this._shared.deleteEmbedding(id);

  // ─── Chats ─────────────────────────────────────────────────
  createChat = (id: string, title: string, model: string, source?: string) =>
    this._chats.createChat(id, title, model, source);
  getChat = (id: string) => this._chats.getChat(id);
  listChats = (limit?: number, source?: string) => this._chats.listChats(limit, source);
  updateChatTitle = (id: string, title: string) => this._chats.updateChatTitle(id, title);
  updateChatModel = (id: string, model: string) => this._chats.updateChatModel(id, model);
  updateChatTimestamp = (id: string) => this._chats.updateChatTimestamp(id);
  deleteChat = (id: string) => this._chats.deleteChat(id);

  // ─── Chat Messages ─────────────────────────────────────────
  appendChatMessage = (chatId: string, role: string, content: string, opts?: { reasoning?: string; model?: string; requestId?: string }) =>
    this._chats.appendChatMessage(chatId, role, content, opts);
  getChatMessages = (chatId: string) => this._chats.getChatMessages(chatId);

  // ─── Telegram Chat Exclusions ──────────────────────────────
  getExcludedTgChats = () => this._chats.getExcludedTgChats();
  getExcludedTgChatIds = () => this._chats.getExcludedTgChatIds();
  excludeTgChat = (chatId: string, chatTitle: string, reason?: string) =>
    this._chats.excludeTgChat(chatId, chatTitle, reason);
  includeTgChat = (chatId: string) => this._chats.includeTgChat(chatId);

  // ─── Layer 4: Raw Log ─────────────────────────────────────
  appendLog = (requestId: string, sessionId: string, agentId: string, role: string, content: string, tokenCount?: number) =>
    this._logs.appendLog(requestId, sessionId, agentId, role, content, tokenCount);
  getLogsByRequest = (requestId: string) => this._logs.getLogsByRequest(requestId);
  getLogsBySession = (sessionId: string, limit?: number) => this._logs.getLogsBySession(sessionId, limit);
  getLogsSince = (afterId: number, limit?: number) => this._logs.getLogsSince(afterId, limit);
  getLogsSinceTime = (sinceUnix: number, limit?: number) =>
    this._logs.getLogsSinceTime(sinceUnix, limit);
  listLog = (limit?: number, offset?: number, sessionId?: string) =>
    this._logs.listLog(limit, offset, sessionId);
  countLog = (sessionId?: string) => this._logs.countLog(sessionId);
  listLogSessions = (limit?: number) => this._logs.listLogSessions(limit);
  groupLogsBySession = (rows: import("./types").LogRow[]) => this._logs.groupLogsBySession(rows);

  // ─── Telegram Messages (FTS index) ─────────────────────────
  insertTgMessage = (msg: TgMessageInsert) => this._tgmsg.insert(msg);
  insertTgMessages = (rows: TgMessageInsert[]) => this._tgmsg.insertMany(rows);
  searchTgMessages = (opts: TgSearchOpts) => this._tgmsg.search(opts);
  recentTgMessages = (chatId: string, limit?: number) =>
    this._tgmsg.recentByChat(chatId, limit);
  countTgMessages = () => this._tgmsg.count();

  // ─── Freelance Leads ───────────────────────────────────────
  insertFreelanceLead = (lead: {
    id: string;
    url: string;
    source: FreelanceSource;
    title: string;
    budget: number | null;
    score: number | null;
    reason: string | null;
  }) => this._freelance.insert(lead);
  getFreelanceLead = (id: string) => this._freelance.getById(id);
  existsFreelanceByUrl = (url: string) => this._freelance.existsByUrl(url);
  listFreelanceLeads = (opts: {
    status?: FreelanceStatus;
    limit: number;
    offset: number;
  }) => this._freelance.list(opts);
  updateFreelanceStatus = (id: string, status: FreelanceStatus) =>
    this._freelance.updateStatus(id, status);
  countFreelanceLeadsSince = (ts: number) => this._freelance.countLeadsSince(ts);
  lastFreelanceLeadAt = () => this._freelance.lastCreatedAt();

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
  listTasksActive = (scope: TaskScope, limit: number) =>
    this._tasks.listActive(scope, limit);
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
  transitionTask = (id: string, to: TaskStatus) =>
    this._tasks.transition(id, to);
  deleteTask = (id: string) => this._tasks.delete(id);
  listCompletedTasksSince = (opts: {
    scope?: TaskScope;
    sinceUnix: number;
    limit: number;
    offset: number;
  }) => this._tasks.listCompletedSince(opts);

  // ─── Scheduler state (ephemeral runtime flags) ─────────────
  getSchedulerState = (key: string) => this._scheduler.get(key);
  upsertSchedulerState = (key: string, value: string) =>
    this._scheduler.upsert(key, value);
  deleteSchedulerState = (key: string) => this._scheduler.delete(key);
  tryAcquireSchedulerLock = (key: string, myId: string, staleSec: number) =>
    this._scheduler.tryAcquireLock(key, myId, staleSec);
  heartbeatSchedulerLock = (key: string, myId: string) =>
    this._scheduler.heartbeat(key, myId);
}
