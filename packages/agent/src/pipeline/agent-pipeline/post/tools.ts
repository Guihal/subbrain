/**
 * OpenAI tool schemas exposed to the post-processing hippocampus agent.
 * Kept inline (not auto-generated from the ToolRegistry) so the hippocampus
 * can evolve its tool surface independently of the public registry. The
 * `task_add` schema is an intentional duplicate of the TypeBox definition in
 * `src/mcp/registry/tasks.tools.ts` — the hippocampus dispatches `task_add`
 * through `registry.call("task_add", ...)`, so the registry validates at
 * runtime and remains the single source of truth for behavior.
 */
import type { Tool } from "@subbrain/providers/types";

export const POST_TOOLS: Tool[] = [
  {
    type: "function",
    function: {
      name: "memory_search",
      description:
        "FTS5 search across memory layers. Use to check whether a candidate fact is already stored before writing a duplicate.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          layer: {
            type: "string",
            enum: ["context", "shared", "all"],
            description: "Default: all",
          },
          limit: { type: "number", description: "Default: 5" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_write",
      description:
        "Persist one fact. SHARED layer (long-lived user-life facts) accepts ONLY categories: profile, preference, goal, relationship, skill, constraint, style. CONTEXT layer (project knowledge) accepts ONLY: project, decision, bug, architecture, learning. DO NOT save: deploy events, commit hashes, current task descriptions, status updates, digest contents, full article texts, ephemeral autonomous-loop state, anything beginning '[from Claude Code CLI]'. For TODO/reminder/deadline use `task_add`. confidence (0..1) is required: ≥0.8 → status='active' (reaches RAG); <0.8 → 'pending' (needs approval). Hard caps: shared content ≤600 chars, context content ≤2000 chars (longer → use layer3_archive).",
      parameters: {
        type: "object",
        properties: {
          layer: { type: "string", enum: ["context", "shared"] },
          category: {
            type: "string",
            description:
              "shared layer: profile|preference|goal|relationship|skill|constraint|style. context layer: project|decision|bug|architecture|learning. Reject for anything else.",
          },
          content: {
            type: "string",
            description: "Self-contained fact, one or two sentences.",
          },
          tags: {
            type: "string",
            description: "Comma-separated, optional",
          },
          confidence: {
            type: "number",
            minimum: 0,
            maximum: 1,
            description:
              "0..1 score. 0.9+ = user-confirmed fact. 0.7–0.9 = strong inference. <0.7 = guess. Facts <0.8 auto-enter the pending queue and are hidden from RAG until approved.",
          },
          expires_at: {
            type: ["number", "null"],
            description:
              "Unix seconds UTC (NOT milliseconds). REQUIRED when category in {plan, strategy, priority, urgent, deadline}. Example: Math.floor(Date.now()/1000) + 30*86400 for +30 days. Must be > now+60s and < 1e12. Null = no expiry (only for non-time-bound categories).",
          },
          supersedes: {
            type: "array",
            items: { type: "string" },
            description:
              "Optional list (≤10) of memory ids in THIS layer that this new write replaces. Each id is marked superseded_by=<new id> in the same transaction. Use when writing a new plan/strategy/priority that obsoletes a prior one. Each id must exist + not already be superseded.",
          },
        },
        required: ["layer", "category", "content", "confidence"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "task_add",
      description:
        "Create a lifecycle task (TODO / reminder / deadline / action item). Use this — not memory_write — when the exchange surfaces something the user or agent must do later. Budget: 3 task mutations per exchange.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Short task title (≤120 chars).",
          },
          description: {
            type: "string",
            description: "Optional long-form detail.",
          },
          scope: {
            type: "string",
            enum: ["global", "autonomous", "free-agent", "freelance", "tg"],
            description: "Namespace. Default: global.",
          },
          due_at: {
            type: ["number", "null"],
            description: "Due date, unix seconds UTC. Null clears.",
          },
          priority: {
            type: "number",
            minimum: 0,
            maximum: 10,
            description: "0..10, higher = more urgent.",
          },
        },
        required: ["title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "done",
      description:
        "Finish extraction. Call this once you've either written all worthwhile facts/tasks or determined the exchange has nothing new.",
      parameters: {
        type: "object",
        properties: {
          note: {
            type: "string",
            description: "Optional short debug note about what you did.",
          },
        },
      },
    },
  },
];
