import { Database } from "bun:sqlite";
import { openDatabase, migrate } from "./schema";
import { MemoryTable } from "./tables/memory";
import { SharedTable } from "./tables/shared";
import { ChatsTable } from "./tables/chats";
import { LogsTable } from "./tables/logs";

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
} from "./types";

export class MemoryDB {
  db: Database;
  private _mem: MemoryTable;
  private _shared: SharedTable;
  private _chats: ChatsTable;
  private _logs: LogsTable;

  constructor(path: string) {
    this.db = openDatabase(path);
    migrate(this.db);
    this._mem = new MemoryTable(this.db);
    this._shared = new SharedTable(this.db);
    this._chats = new ChatsTable(this.db);
    this._logs = new LogsTable(this.db);
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
  insertContext = (id: string, title: string, content: string, tags?: string, derivedFrom?: string[], agentId?: string) =>
    this._mem.insertContext(id, title, content, tags, derivedFrom, agentId);
  updateContext = (id: string, fields: { title?: string; content?: string; tags?: string }) =>
    this._mem.updateContext(id, fields);
  getContext = (id: string) => this._mem.getContext(id);
  listContext = (limit?: number, offset?: number) => this._mem.listContext(limit, offset);
  countContext = () => this._mem.countContext();
  deleteContext = (id: string) => this._mem.deleteContext(id);

  // ─── Layer 3: Archive ──────────────────────────────────────
  insertArchive = (id: string, title: string, content: string, tags?: string, sourceRequestIds?: string[], confidence?: "HIGH" | "LOW", agentId?: string) =>
    this._mem.insertArchive(id, title, content, tags, sourceRequestIds, confidence, agentId);
  getArchive = (id: string) => this._mem.getArchive(id);
  listArchive = (limit?: number, offset?: number) => this._mem.listArchive(limit, offset);
  countArchive = () => this._mem.countArchive();
  updateArchive = (id: string, fields: { title?: string; content?: string; tags?: string; confidence?: "HIGH" | "LOW" }) =>
    this._mem.updateArchive(id, fields);
  deleteArchive = (id: string) => this._mem.deleteArchive(id);

  // ─── FTS5 Search (context + archive) ──────────────────────
  searchContext = (query: string, limit?: number) => this._mem.searchContext(query, limit);
  searchArchive = (query: string, limit?: number) => this._mem.searchArchive(query, limit);

  // ─── Shared Memory ─────────────────────────────────────────
  insertShared = (id: string, category: string, content: string, tags?: string, source?: string) =>
    this._shared.insertShared(id, category, content, tags, source);
  getAllShared = () => this._shared.getAllShared();
  listShared = (limit?: number, offset?: number, category?: string) =>
    this._shared.listShared(limit, offset, category);
  countShared = (category?: string) => this._shared.countShared(category);
  getShared = (id: string) => this._shared.getShared(id);
  getSharedByCategory = (category: string) => this._shared.getSharedByCategory(category);
  updateShared = (id: string, fields: { content?: string; tags?: string; category?: string }) =>
    this._shared.updateShared(id, fields);
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
  searchShared = (query: string, limit?: number) => this._shared.searchShared(query, limit);
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
  listLog = (limit?: number, offset?: number, sessionId?: string) =>
    this._logs.listLog(limit, offset, sessionId);
  countLog = (sessionId?: string) => this._logs.countLog(sessionId);
  listLogSessions = (limit?: number) => this._logs.listLogSessions(limit);
  groupLogsBySession = (rows: import("./types").LogRow[]) => this._logs.groupLogsBySession(rows);
}
