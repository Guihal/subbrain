/**
 * Logging and history compression operations extracted from ToolExecutor.
 */
import type { MemoryDB } from "../../db";
import type { ModelRouter } from "../../lib/model-router";
import type { ToolResult } from "../types";

export class LogTools {
  constructor(
    private memory: MemoryDB,
    private router: ModelRouter,
  ) {}

  append(
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

  read(sessionId?: string, requestId?: string, limit?: number): ToolResult {
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
}
