import { randomUUID } from "crypto";
import type { MemoryDB, FtsResult, VecResult } from "../db";
import type { ModelRouter } from "../lib/model-router";
import type { RAGPipeline } from "../rag";
import type { Userbot } from "../telegram/userbot";

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

/**
 * Core tool logic, independent of transport (MCP/HTTP/internal).
 * All tools return a standardized ToolResult.
 */
export class ToolExecutor {
  private rag: RAGPipeline | null = null;
  private userbot: Userbot | null = null;

  constructor(
    private memory: MemoryDB,
    private router: ModelRouter,
  ) {}

  /** Set RAG pipeline (avoids circular dependency) */
  setRAG(rag: RAGPipeline): void {
    this.rag = rag;
  }

  /** Set Telegram userbot for chat reading */
  setUserbot(userbot: Userbot): void {
    this.userbot = userbot;
  }

  // ─── Memory CRUD ─────────────────────────────────────────

  memoryRead(id: string, layer?: string): ToolResult {
    let data: unknown = null;

    if (!layer || layer === "context") data = this.memory.getContext(id);
    if (!data && (!layer || layer === "archive"))
      data = this.memory.getArchive(id);
    if (!data && (!layer || layer === "shared")) {
      data = this.memory.db
        .query("SELECT * FROM shared_memory WHERE id = ?")
        .get(id);
    }
    if (!data && (!layer || layer === "agent")) {
      data = this.memory.db
        .query("SELECT * FROM agent_memory WHERE id = ?")
        .get(id);
    }

    if (!data) return { success: false, error: "Not found" };
    return { success: true, data };
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
    const id = params.id || randomUUID();

    switch (params.layer) {
      case "focus":
        if (!params.key)
          return { success: false, error: "key required for focus layer" };
        this.memory.setFocus(params.key, params.content);
        return { success: true, data: { key: params.key } };

      case "context":
        if (this.memory.getContext(id)) {
          this.memory.updateContext(id, {
            title: params.title,
            content: params.content,
            tags: params.tags,
          });
        } else {
          this.memory.insertContext(
            id,
            params.title || "Untitled",
            params.content,
            params.tags || "",
            [],
            params.agent_id,
          );
        }
        break;

      case "archive":
        if (this.memory.getArchive(id)) {
          this.memory.updateArchive(id, {
            title: params.title,
            content: params.content,
            tags: params.tags,
            confidence: params.confidence,
          });
        } else {
          this.memory.insertArchive(
            id,
            params.title || "Untitled",
            params.content,
            params.tags || "",
            [],
            params.confidence || "HIGH",
            params.agent_id,
          );
        }
        break;

      case "shared":
        this.memory.insertShared(
          id,
          params.category || "general",
          params.content,
          params.tags || "",
        );
        break;

      case "agent":
        if (!params.agent_id)
          return { success: false, error: "agent_id required for agent layer" };
        this.memory.insertAgentMemory(
          id,
          params.agent_id,
          params.content,
          params.tags || "",
        );
        break;

      default:
        return { success: false, error: `Unknown layer: ${params.layer}` };
    }

    // Fire-and-forget: embed for RAG index
    if (this.rag && params.layer !== "focus") {
      this.rag.indexEntry(id, params.layer, params.content).catch(() => {});
    }

    return { success: true, data: { id } };
  }

  memoryDelete(id: string, layer: string): ToolResult {
    switch (layer) {
      case "context":
        this.memory.deleteContext(id);
        break;
      case "archive":
        this.memory.deleteArchive(id);
        break;
      case "shared":
        this.memory.deleteShared(id);
        break;
      case "agent":
        this.memory.deleteAgentMemory(id);
        break;
      default:
        return { success: false, error: `Unknown layer: ${layer}` };
    }
    this.memory.deleteEmbedding(id);
    return { success: true };
  }

  memorySearch(query: string, layer?: string, limit?: number): ToolResult {
    // If RAG is available, prefer hybrid search (async wrapper)
    // For sync FTS-only fallback when RAG is not wired
    const n = limit || 10;
    const target = layer || "all";
    const results: Record<string, FtsResult[]> = {};

    if (target === "all" || target === "context") {
      results.context = this.memory.searchContext(query, n);
    }
    if (target === "all" || target === "archive") {
      results.archive = this.memory.searchArchive(query, n);
    }
    if (target === "all" || target === "shared") {
      results.shared = this.memory.searchShared(query, n);
    }

    return { success: true, data: results };
  }

  /**
   * Hybrid RAG search: FTS5 + vector → RRF → rerank.
   * Use this when RPM budget allows (costs 1-2 RPM).
   */
  async ragSearch(
    query: string,
    layers?: ("context" | "archive" | "shared")[],
    topN?: number,
    skipRerank?: boolean,
  ): Promise<ToolResult> {
    if (!this.rag) {
      return this.memorySearch(query, layers?.[0], topN);
    }

    const results = await this.rag.search({
      query,
      layers,
      rerankTopN: topN || 5,
      skipRerank,
    });

    return { success: true, data: results };
  }

  // ─── Logging ─────────────────────────────────────────────

  logAppend(
    requestId: string,
    sessionId: string,
    agentId: string,
    role: string,
    content: string,
    tokenCount?: number,
  ): ToolResult {
    const id = this.memory.appendLog(
      requestId,
      sessionId,
      agentId,
      role,
      content,
      tokenCount,
    );
    return { success: true, data: { id } };
  }

  logRead(sessionId?: string, requestId?: string, limit?: number): ToolResult {
    if (requestId) {
      return { success: true, data: this.memory.getLogsByRequest(requestId) };
    }
    if (sessionId) {
      return {
        success: true,
        data: this.memory.getLogsBySession(sessionId, limit || 100),
      };
    }
    return { success: false, error: "session_id or request_id required" };
  }

  // ─── Embeddings ──────────────────────────────────────────

  async embedText(
    text: string,
    type: "text" | "code" = "text",
  ): Promise<ToolResult> {
    const modelId =
      type === "code"
        ? "nvidia/nv-embedcode-7b-v1"
        : "nvidia/llama-3.2-nemoretriever-300m-embed-v1";

    const result = await this.router.scheduleRaw("normal", () =>
      this.router.raw.embed({
        model: modelId,
        input: [text],
        input_type: "passage",
      }),
    );

    return {
      success: true,
      data: {
        embedding: result.data[0].embedding,
        model: modelId,
        dim: result.data[0].embedding.length,
      },
    };
  }

  async embedSearch(
    query: string,
    topK?: number,
    layer?: string,
  ): Promise<ToolResult> {
    const embedResult = await this.router.scheduleRaw("normal", () =>
      this.router.raw.embed({
        model: "nvidia/llama-3.2-nemoretriever-300m-embed-v1",
        input: [query],
        input_type: "query",
      }),
    );

    const embedding = new Float32Array(embedResult.data[0].embedding);
    const results = this.memory.searchEmbeddings(embedding, topK || 10, layer);

    return { success: true, data: results };
  }

  // ─── Rerank ──────────────────────────────────────────────

  async rerank(
    query: string,
    passages: string[],
    topN?: number,
  ): Promise<ToolResult> {
    const result = await this.router.scheduleRaw("normal", () =>
      this.router.raw.rerank({
        model: "nvidia/rerank-qa-mistral-4b",
        query,
        passages: passages.map((text) => ({ text })),
        top_n: topN || passages.length,
      }),
    );

    return { success: true, data: result.results };
  }

  // ─── Utilities ───────────────────────────────────────────

  contextSummary(sessionId: string): ToolResult {
    const logs = this.memory.getLogsBySession(sessionId, 50);
    const focus = this.memory.getAllFocus();

    return {
      success: true,
      data: {
        focus,
        recent_log_count: logs.length,
        recent_logs: logs.slice(0, 10).map((l) => ({
          role: l.role,
          content: l.content.substring(0, 200),
          agent_id: l.agent_id,
        })),
      },
    };
  }

  async compressHistory(
    messages: { role: string; content: string }[],
  ): Promise<ToolResult> {
    const result = await this.router.chat(
      "flash",
      {
        messages: [
          {
            role: "system",
            content:
              "You are a compression assistant. Summarize the following conversation into a concise Markdown summary. Preserve key decisions, code snippets, and action items. Be brief but complete.",
          },
          {
            role: "user",
            content: messages
              .map((m) => `**${m.role}:** ${m.content}`)
              .join("\n\n"),
          },
        ],
        max_tokens: 2048,
      },
      "normal",
    );

    const summary = result.choices[0]?.message?.content || "Failed to compress";
    return { success: true, data: { summary } };
  }

  // ─── Telegram Chat Tools ─────────────────────────────────

  private requireUserbot(): Userbot {
    if (!this.userbot || !this.userbot.isConnected()) {
      throw new Error(
        "Telegram userbot not connected. Set TG_API_ID, TG_API_HASH, TG_SESSION.",
      );
    }
    return this.userbot;
  }

  async tgListChats(limit = 100): Promise<ToolResult> {
    try {
      const ub = this.requireUserbot();
      const chats = await ub.listChats(limit);
      return { success: true, data: chats };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async tgReadChat(
    chatId: string,
    limit = 50,
    offsetId?: number,
  ): Promise<ToolResult> {
    try {
      const ub = this.requireUserbot();
      const messages = await ub.readChat(chatId, limit, offsetId);
      return { success: true, data: messages };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async tgSearchMessages(
    query: string,
    limit = 30,
    chatId?: string,
  ): Promise<ToolResult> {
    try {
      const ub = this.requireUserbot();
      const messages = await ub.searchMessages(query, limit, chatId);
      return { success: true, data: messages };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  tgExcludeChat(
    chatId: string,
    chatTitle: string,
    reason = "private",
  ): ToolResult {
    try {
      this.memory.excludeTgChat(chatId, chatTitle, reason);
      return { success: true, data: { excluded: chatId, chatTitle, reason } };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  tgIncludeChat(chatId: string): ToolResult {
    try {
      this.memory.includeTgChat(chatId);
      return { success: true, data: { included: chatId } };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  tgListExcluded(): ToolResult {
    try {
      const excluded = this.memory.getExcludedTgChats();
      return { success: true, data: excluded };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }
}
