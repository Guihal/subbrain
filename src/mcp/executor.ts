import type { MemoryDB, FtsResult, VecResult } from "../db";
import type { ModelRouter } from "../lib/model-router";
import type { RAGPipeline } from "../rag";
import type { PlaywrightClient } from "./playwright-client";
import type { ToolResult } from "./types";
import { MemoryTools, EmbedTools, LogTools, WebTools } from "./tools/index";

export type { ToolResult } from "./types";

/**
 * Core tool logic, independent of transport (MCP/HTTP/internal).
 * Delegates to domain-specific tool modules.
 */
export class ToolExecutor {
  private rag: RAGPipeline | null = null;
  private botNotify: ((text: string) => Promise<void>) | null = null;

  // Domain modules
  readonly memoryTools: MemoryTools;
  readonly embedTools: EmbedTools;
  readonly logTools: LogTools;
  readonly webTools: WebTools;

  constructor(
    private memory: MemoryDB,
    private router: ModelRouter,
  ) {
    this.memoryTools = new MemoryTools(memory, () => this.rag);
    this.embedTools = new EmbedTools(memory, router, () => this.rag);
    this.logTools = new LogTools(memory, router);
    this.webTools = new WebTools();
  }

  /** Set RAG pipeline (avoids circular dependency) */
  setRAG(rag: RAGPipeline): void {
    this.rag = rag;
  }

  /** Set Telegram bot notify function for sending messages to owner */
  setBotNotify(fn: (text: string) => Promise<void>): void {
    this.botNotify = fn;
  }

  /** Send a message to the owner via Telegram bot */
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
    confidence?: "HIGH" | "LOW";
    key?: string;
  }): ToolResult {
    return this.memoryTools.write(params);
  }

  memoryDelete(id: string, layer: string): ToolResult {
    return this.memoryTools.delete(id, layer);
  }

  memorySearch(query: string, layer?: string, limit?: number): ToolResult {
    return this.memoryTools.search(query, layer, limit);
  }

  async ragSearch(
    query: string,
    layers?: ("context" | "archive" | "shared")[],
    topN?: number,
    skipRerank?: boolean,
  ): Promise<ToolResult> {
    return this.embedTools.ragSearch(query, layers, topN, skipRerank);
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
}
