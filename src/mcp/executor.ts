import type { MemoryDB, FtsResult, VecResult } from "../db";
import type { ModelRouter } from "../lib/model-router";
import type { RAGPipeline } from "../rag";
import type { Userbot } from "../telegram/userbot";
import type { PlaywrightClient } from "./playwright-client";
import type { ToolResult } from "./types";
import {
  MemoryTools,
  EmbedTools,
  LogTools,
  WebTools,
  TasksTools,
} from "./tools/index";
import { MemoryCurationTools } from "./tools/memory-curation-tools";
import * as tg from "./telegram-tools";
import { sendReport } from "./tools/telegram-report";
import type { CodeToolRegistry } from "../pipeline/agent-loop/code-tools";
import type { ArbitrationRoom } from "../pipeline/arbitration";
import type { MemoryService } from "../services/memory.service";

export type { ToolResult } from "./types";

/**
 * Core tool logic, independent of transport (MCP/HTTP/internal).
 * Delegates to domain-specific tool modules.
 */
export class ToolExecutor {
  private rag: RAGPipeline | null = null;
  private userbot: Userbot | null = null;
  private botNotify: ((text: string) => Promise<void>) | null = null;
  private _codeTools: CodeToolRegistry | null = null;
  private _room: ArbitrationRoom | null = null;
  // M-FINAL2 / M-10: MemoryService is wired post-ctor (depends on RAG, which
  // is itself set post-ctor). Curation tools need it for `memory_promote`
  // (insertShared) + `memory_reflect` (runReflect deps), so we keep the
  // reference directly on the executor instead of fishing it out of
  // `memoryTools`.
  private _memoryService: MemoryService | null = null;

  // Domain modules
  readonly memoryTools: MemoryTools;
  readonly memoryCurationTools: MemoryCurationTools;
  readonly embedTools: EmbedTools;
  readonly logTools: LogTools;
  readonly webTools: WebTools;
  readonly tasksTools: TasksTools;

  constructor(
    private memory: MemoryDB,
    private router: ModelRouter,
  ) {
    this.memoryTools = new MemoryTools(memory, () => this.rag);
    this.memoryCurationTools = new MemoryCurationTools(
      memory,
      () => this._memoryService,
      () => this.rag,
      () => this.router,
    );
    this.embedTools = new EmbedTools(memory, router, () => this.rag);
    this.logTools = new LogTools(memory, router);
    this.webTools = new WebTools();
    this.tasksTools = new TasksTools(memory);
  }

  /** Set RAG pipeline (avoids circular dependency) */
  setRAG(rag: RAGPipeline): void {
    this.rag = rag;
  }

  /**
   * M-FINAL2: inject MemoryService so MemoryTools.write `case shared`
   * delegates to the single embed-first + transactional implementation
   * instead of the inline `writeSharedAtomic` fallback. Wired post-ctor
   * because the service depends on RAG, which is itself set post-ctor.
   */
  setMemoryService(service: MemoryService): void {
    this._memoryService = service;
    this.memoryTools.setMemoryService(service);
  }

  /** Expose memory for tools that need direct DB access (report-context). */
  get memoryDb(): MemoryDB {
    return this.memory;
  }

  /** Expose RAG for tools (may be null until setRAG was called). */
  get ragPipeline(): RAGPipeline | null {
    return this.rag;
  }

  /** Set Telegram bot notify function for sending messages to owner */
  setBotNotify(fn: (text: string) => Promise<void>): void {
    this.botNotify = fn;
  }

  /** Set Telegram userbot for chat reading */
  setUserbot(userbot: Userbot): void {
    this.userbot = userbot;
  }

  /**
   * Send a message to the owner via Telegram bot.
   *
   * Relies on `botNotify` being the throwing variant (`notifyOrThrow`) so we
   * can surface real delivery failures — `notify` (fire-and-forget) would
   * resolve `void` even on HTTP 500, masking the error.
   */
  async tgSendMessage(text: string): Promise<ToolResult> {
    if (!this.botNotify) {
      return { success: false, error: "Telegram bot not configured" };
    }
    try {
      await this.botNotify(text);
      return { success: true, data: "Message sent to owner" };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  }

  /** Set CodeToolRegistry for public code-tools access */
  setCodeTools(codeTools: CodeToolRegistry): void {
    this._codeTools = codeTools;
  }

  /** Get CodeToolRegistry instance */
  get codeTools(): CodeToolRegistry | null {
    return this._codeTools;
  }

  /** Set ArbitrationRoom so public tool callers (MCP/REST) can invoke consult_* */
  setRoom(room: ArbitrationRoom): void {
    this._room = room;
  }

  /** Arbitration room (may be null until setRoom was called) */
  get room(): ArbitrationRoom | null {
    return this._room;
  }

  /** Expose router for public tool callers (consult_chaos et al.) */
  get modelRouter(): ModelRouter {
    return this.router;
  }

  /** Set Playwright MCP client for web browsing */
  setPlaywright(pw: PlaywrightClient): void {
    this.webTools.setPlaywright(pw);
  }

  /** Call a Playwright MCP tool (browser_navigate, browser_snapshot, etc.) */
  async webCallTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    return this.webTools.callTool(name, args);
  }

  // ─── Memory CRUD (delegated) ──────────────────────────────

  memoryRead(id: string, layer?: string): ToolResult {
    return this.memoryTools.read(id, layer);
  }

  memoryWrite(params: {
    layer: string;
    content: string;
    id?: string;
    title?: string;
    tags?: string;
    category?: string;
    agent_id?: string;
    // M-12 (mig 15): unified numeric confidence [0..1]. Legacy "HIGH"/"LOW"
    // strings still accepted by `MemoryTools.write` fallback for direct test
    // callers (registry validator rejects strings — see memory-tools.ts).
    confidence?: number | "HIGH" | "LOW";
    key?: string;
  }, agentId: string | null = null): ToolResult | Promise<ToolResult> {
    // MEM-2 (M-01): the `shared` layer returns a Promise so callers (registry
    // handler — accepts ToolResult | Promise<ToolResult>) await embed+insert.
    // Other layers stay sync.
    return this.memoryTools.write(params, agentId);
  }

  memoryDelete(id: string, layer: string, agentId: string | null = null): ToolResult {
    return this.memoryTools.delete(id, layer, agentId);
  }

  memorySearch(
    query: string,
    layer?: string,
    limit?: number,
    agentId: string | null = null,
  ): ToolResult {
    return this.memoryTools.search(query, layer, limit, agentId);
  }

  async ragSearch(
    query: string,
    layers?: ("context" | "archive" | "shared")[],
    topN?: number,
    skipRerank?: boolean,
    agentId: string | null = null,
  ): Promise<ToolResult> {
    return this.embedTools.ragSearch(query, layers, topN, skipRerank, agentId);
  }

  // ─── Logging (delegated) ─────────────────────────────────

  logAppend(
    requestId: string,
    sessionId: string,
    agentId: string,
    role: string,
    content: string,
    tokenCount?: number,
  ): ToolResult {
    return this.logTools.append(
      requestId,
      sessionId,
      agentId,
      role,
      content,
      tokenCount,
    );
  }

  logRead(sessionId?: string, requestId?: string, limit?: number): ToolResult {
    return this.logTools.read(sessionId, requestId, limit);
  }

  // ─── Embeddings (delegated) ──────────────────────────────

  async embedText(
    text: string,
    type: "text" | "code" = "text",
  ): Promise<ToolResult> {
    return this.embedTools.embedText(text, type);
  }

  async embedSearch(
    query: string,
    topK?: number,
    layer?: string,
  ): Promise<ToolResult> {
    return this.embedTools.embedSearch(query, topK, layer);
  }

  async rerank(
    query: string,
    passages: string[],
    topN?: number,
  ): Promise<ToolResult> {
    return this.embedTools.rerank(query, passages, topN);
  }

  // ─── Utilities (delegated) ───────────────────────────────

  contextSummary(sessionId: string): ToolResult {
    return this.memoryTools.contextSummary(sessionId);
  }

  async compressHistory(
    messages: { role: string; content: string }[],
  ): Promise<ToolResult> {
    return this.logTools.compressHistory(messages);
  }

  // ─── Telegram Chat Tools (MTProto userbot) ───────────────

  async tgListChats(limit = 100): Promise<ToolResult> {
    return tg.tgListChats(this.userbot, limit);
  }

  async tgReadChat(
    chatId: string,
    limit = 50,
    offsetId?: number,
  ): Promise<ToolResult> {
    return tg.tgReadChat(this.userbot, chatId, limit, offsetId);
  }

  async tgSearchMessages(
    query: string,
    limit = 30,
    chatId?: string,
  ): Promise<ToolResult> {
    return tg.tgSearchMessages(this.userbot, query, limit, chatId);
  }

  tgExcludeChat(
    chatId: string,
    chatTitle: string,
    reason = "private",
  ): ToolResult {
    return tg.tgExcludeChat(this.memory, chatId, chatTitle, reason);
  }

  tgIncludeChat(chatId: string): ToolResult {
    return tg.tgIncludeChat(this.memory, chatId);
  }

  tgListExcluded(): ToolResult {
    return tg.tgListExcluded(this.memory);
  }

  /** FTS5 search over locally indexed TG messages. */
  tgFtsSearch(
    query: string,
    chatId?: string,
    from?: string,
    to?: string,
    limit?: number,
  ): ToolResult {
    try {
      const fromTs = from ? Math.floor(Date.parse(from) / 1000) : undefined;
      const toTs = to ? Math.floor(Date.parse(to) / 1000) : undefined;
      if ((from && Number.isNaN(fromTs)) || (to && Number.isNaN(toTs))) {
        return { success: false, error: "Invalid from/to ISO date" };
      }
      const opts: import("../db").TgSearchOpts = { query };
      if (chatId) opts.chatId = chatId;
      if (fromTs !== undefined) opts.from = fromTs;
      if (toTs !== undefined) opts.to = toTs;
      if (limit !== undefined) opts.limit = limit;
      const { items, total } = this.memory.searchTgMessages(opts);
      return {
        success: true,
        data: {
          items: items.map((h) => ({
            ts: h.ts,
            chat: h.chat_name,
            chat_id: h.chat_id,
            from: h.from_name,
            text: h.text,
            message_id: h.message_id,
          })),
          total,
        },
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** RAG-обогащённая отправка отчёта (REPORT_RAG kill-switch внутри). */
  async sendReportEnriched(
    text: string,
    opts?: { topic?: string; sinceHours?: number },
  ): Promise<ToolResult> {
    return sendReport({ executor: this, agentId: null }, text, {
      topic: opts?.topic,
      sinceHours: opts?.sinceHours,
      memory: this.memory,
      rag: this.rag,
    });
  }
}
