/**
 * Memory CRUD + context_summary.
 *
 * Логика по-прежнему живёт в src/mcp/tools/memory-tools.ts (MemoryTools).
 * Здесь — только декларация интерфейса для реестра.
 */
import { t, type ToolRegistry } from "./tool-registry";

export function registerMemoryTools(registry: ToolRegistry): void {
  registry.register({
    name: "memory_read",
    description: "Read a memory entry by ID from any layer.",
    scope: "public",
    input: t.Object({
      id: t.String({ description: "Memory entry ID" }),
      layer: t.Optional(
        t.Union(
          [
            t.Literal("context"),
            t.Literal("archive"),
            t.Literal("shared"),
            t.Literal("agent"),
          ],
          { description: "Restrict search to a specific layer" },
        ),
      ),
    }),
    handler: (args, ctx) =>
      ctx.executor.memoryTools.read(args.id, args.layer),
  });

  registry.register({
    name: "memory_write",
    description:
      "Create or update a memory entry. Use to save decisions, facts, plans. `confidence` (0..1) is required: values below MEMORY_AUTOACCEPT_CONFIDENCE (default 0.8) land as status='pending' and require human approval before RAG injection.",
    scope: "public",
    input: t.Object({
      layer: t.Union([
        t.Literal("focus"),
        t.Literal("context"),
        t.Literal("archive"),
        t.Literal("shared"),
        t.Literal("agent"),
      ]),
      content: t.String({ description: "Content to store" }),
      confidence: t.Number({
        minimum: 0,
        maximum: 1,
        description:
          "Confidence 0..1. >= MEMORY_AUTOACCEPT_CONFIDENCE (default 0.8) → status='active'; below → status='pending'. For archive layer this maps to HIGH (>= 0.8) or LOW (< 0.8).",
      }),
      id: t.Optional(t.String()),
      title: t.Optional(t.String({ description: "Title (context/archive)" })),
      tags: t.Optional(t.String({ description: "Comma-separated tags" })),
      category: t.Optional(
        t.String({ description: "Category (shared layer)" }),
      ),
      agent_id: t.Optional(t.String({ description: "Agent ID (agent layer)" })),
      key: t.Optional(t.String({ description: "Key (focus layer)" })),
    }),
    handler: (args, ctx) => ctx.executor.memoryTools.write(args, ctx.agentId),
  });

  registry.register({
    name: "memory_delete",
    description: "Delete a memory entry by ID.",
    scope: "public",
    input: t.Object({
      id: t.String(),
      layer: t.Union([
        t.Literal("context"),
        t.Literal("archive"),
        t.Literal("shared"),
        t.Literal("agent"),
      ]),
    }),
    handler: (args, ctx) =>
      ctx.executor.memoryTools.delete(args.id, args.layer, ctx.agentId),
  });

  registry.register({
    name: "memory_search",
    description:
      "Search across memory layers (FTS5 full-text). Returns relevant memories.",
    scope: "public",
    input: t.Object({
      query: t.String({ description: "Search query" }),
      layer: t.Optional(
        t.Union(
          [
            t.Literal("context"),
            t.Literal("archive"),
            t.Literal("shared"),
            t.Literal("all"),
          ],
          { description: "Which layer to search (default: all)" },
        ),
      ),
      limit: t.Optional(
        t.Number({ description: "Max results (default: 10)" }),
      ),
    }),
    handler: (args, ctx) =>
      ctx.executor.memoryTools.search(args.query, args.layer, args.limit, ctx.agentId),
  });

  registry.register({
    name: "context_summary",
    description:
      "Get executive summary of memory context for the current session.",
    scope: "public",
    input: t.Object({
      session_id: t.String(),
    }),
    handler: (args, ctx) => ctx.executor.memoryTools.contextSummary(args.session_id),
  });

  // M-04: agent-only FTS5 search over Layer 4 (raw_log). Hidden from
  // public REST/MCP because raw log rows hold pre-scrub PII (user input
  // before night-cycle sanitization). Reachable only inside the agent
  // loop. Default limit 20; optional agentId / sessionId narrow the scan.
  registry.register({
    name: "memory_log_search",
    description:
      "Search Layer 4 raw log (FTS5) by content. Agent-only — raw logs may contain PII before night-cycle scrub. Returns id (log row), role (as title), snippet with <b>...</b> highlight, and timestamps.",
    scope: "agent-only",
    input: t.Object({
      query: t.String({ description: "Search query (sanitized for FTS5)" }),
      limit: t.Optional(
        t.Number({ description: "Max rows (default 20)" }),
      ),
      agentId: t.Optional(
        t.String({ description: "Restrict to a single agent's rows" }),
      ),
      sessionId: t.Optional(
        t.String({ description: "Restrict to a single session's rows" }),
      ),
    }),
    handler: (args, ctx) => {
      const hits = ctx.executor.memoryDb.logRepo.searchLog(args.query, {
        limit: args.limit,
        agentId: args.agentId,
        sessionId: args.sessionId,
      });
      return { success: true, data: hits };
    },
  });
}
