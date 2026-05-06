import type { MemoryDB } from "@subbrain/core/db";
import type { ModelRouter } from "@subbrain/core/lib/model-router";
import type { CodeToolRegistry } from "../../pipeline/agent-loop/code-tools";
import type { ArbitrationRoom } from "../../pipeline/arbitration";
import type { RAGPipeline } from "../../rag";
import type { MemoryService } from "../../services/memory";
import type { Userbot } from "../../telegram/userbot";
import type { PlaywrightClient } from "../playwright";
import { EmbedTools, LogTools, MemoryTools, TasksTools, WebTools } from "../tools/index";
import { MemoryCurationTools } from "../tools/memory-curation-tools";
import { sendReport } from "../tools/telegram-report";
import type { ToolResult } from "../types";
import * as data from "./ops-data";
import * as mem from "./ops-memory";
import * as tg from "./ops-tg";
import type { ExecutorState } from "./types";

export type { ToolResult } from "../types";
export type { ExecutorState } from "./types";

/** Core tool logic, transport-independent. Delegates to ops-memory/data/tg. */
export class ToolExecutor {
  private rag: RAGPipeline | null = null;
  private userbot: Userbot | null = null;
  private botNotify: ((text: string) => Promise<void>) | null = null;
  private _codeTools: CodeToolRegistry | null = null;
  private _room: ArbitrationRoom | null = null;
  private _memoryService: MemoryService | null = null;
  private _approvalNotifier: ((row: import("@subbrain/core/db").ApprovalRow) => void) | null = null;

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

  private state(): ExecutorState {
    return {
      memory: this.memory,
      router: this.router,
      rag: this.rag,
      userbot: this.userbot,
      botNotify: this.botNotify,
      approvalNotifier: this._approvalNotifier,
      codeTools: this._codeTools,
      room: this._room,
      memoryService: this._memoryService,
      memoryTools: this.memoryTools,
      memoryCurationTools: this.memoryCurationTools,
      embedTools: this.embedTools,
      logTools: this.logTools,
      webTools: this.webTools,
      tasksTools: this.tasksTools,
    };
  }

  setRAG(rag: RAGPipeline) {
    this.rag = rag;
  }
  setMemoryService(s: MemoryService) {
    this._memoryService = s;
    this.memoryTools.setMemoryService(s);
  }
  setBotNotify(fn: (text: string) => Promise<void>) {
    this.botNotify = fn;
  }
  setApprovalNotifier(fn: (row: import("@subbrain/core/db").ApprovalRow) => void) {
    this._approvalNotifier = fn;
  }
  setUserbot(userbot: Userbot) {
    this.userbot = userbot;
  }
  setCodeTools(codeTools: CodeToolRegistry) {
    this._codeTools = codeTools;
  }
  setRoom(room: ArbitrationRoom) {
    this._room = room;
  }
  setPlaywright(pw: PlaywrightClient) {
    this.webTools.setPlaywright(pw);
  }
  get memoryDb(): MemoryDB {
    return this.memory;
  }
  get ragPipeline(): RAGPipeline | null {
    return this.rag;
  }
  get codeTools(): CodeToolRegistry | null {
    return this._codeTools;
  }
  get room(): ArbitrationRoom | null {
    return this._room;
  }
  get modelRouter(): ModelRouter {
    return this.router;
  }
  get approvalNotifier(): ((row: import("@subbrain/core/db").ApprovalRow) => void) | null {
    return this._approvalNotifier;
  }

  webCallTool = (name: string, args: Record<string, unknown>) => this.webTools.callTool(name, args);

  memoryRead = (id: string, layer?: string) => mem.memoryRead(this.state(), id, layer);
  memoryWrite = (params: Parameters<typeof mem.memoryWrite>[1], agentId: string | null = null) =>
    mem.memoryWrite(this.state(), params, agentId);
  memoryDelete = (id: string, layer: string, agentId: string | null = null) =>
    mem.memoryDelete(this.state(), id, layer, agentId);
  memorySearch = (query: string, layer?: string, limit?: number, agentId: string | null = null) =>
    mem.memorySearch(this.state(), query, layer, limit, agentId);
  ragSearch = (
    query: string,
    layers?: ("context" | "archive" | "shared")[],
    topN?: number,
    skipRerank?: boolean,
    agentId: string | null = null,
  ) => mem.ragSearch(this.state(), query, layers, topN, skipRerank, agentId);
  contextSummary = (sessionId: string) => mem.contextSummary(this.state(), sessionId);
  logAppend = (
    requestId: string,
    sessionId: string,
    agentId: string,
    role: string,
    content: string,
    tokenCount?: number,
  ) => data.logAppend(this.state(), requestId, sessionId, agentId, role, content, tokenCount);
  logRead = (sessionId?: string, requestId?: string, limit?: number) =>
    data.logRead(this.state(), sessionId, requestId, limit);
  compressHistory = (messages: { role: string; content: string }[]) =>
    data.compressHistory(this.state(), messages);
  embedText = (text: string, type: "text" | "code" = "text") =>
    data.embedText(this.state(), text, type);
  embedSearch = (query: string, topK?: number, layer?: string) =>
    data.embedSearch(this.state(), query, topK, layer);
  rerank = (query: string, passages: string[], topN?: number) =>
    data.rerank(this.state(), query, passages, topN);
  tgSendMessage = (text: string) => tg.tgSendMessage(this.state(), text);
  tgListChats = (limit = 100) => tg.tgListChats(this.state(), limit);
  tgReadChat = (chatId: string, limit = 50, offsetId?: number) =>
    tg.tgReadChat(this.state(), chatId, limit, offsetId);
  tgSearchMessages = (query: string, limit = 30, chatId?: string) =>
    tg.tgSearchMessages(this.state(), query, limit, chatId);
  tgExcludeChat = (chatId: string, chatTitle: string, reason = "private") =>
    tg.tgExcludeChat(this.state(), chatId, chatTitle, reason);
  tgIncludeChat = (chatId: string) => tg.tgIncludeChat(this.state(), chatId);
  tgListExcluded = () => tg.tgListExcluded(this.state());
  tgSetChatPolicy = (chatId: string, policy: "full" | "scrubbed" | "metadata_only", updatedBy?: string) =>
    tg.tgSetChatPolicy(this.state(), chatId, policy, updatedBy);
  tgFtsSearch = (query: string, chatId?: string, from?: string, to?: string, limit?: number) =>
    tg.tgFtsSearch(this.state(), query, chatId, from, to, limit);

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
