/**
 * OpenAI tool schemas exposed to the post-processing hippocampus agent.
 * Kept inline (not auto-generated from the ToolRegistry) so the hippocampus
 * can evolve its tool surface independently of the public registry. The
 * `task_add` schema is an intentional duplicate of the TypeBox definition in
 * `src/mcp/registry/tasks.tools.ts` — the hippocampus dispatches `task_add`
 * through `registry.call("task_add", ...)`, so the registry validates at
 * runtime and remains the single source of truth for behavior.
 */
import type { Tool } from "../../../providers/types";

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
        "Persist one fact. Use `shared` for long-lived facts about the user / their life / persistent preferences. Use `context` for project decisions, code findings, transient domain knowledge. For TODO/reminder/deadline use `task_add` instead.",
      parameters: {
        type: "object",
        properties: {
          layer: { type: "string", enum: ["context", "shared"] },
          category: {
            type: "string",
            description:
              "Short category tag: user, project, decision, finding, url, preference, etc.",
          },
          content: {
            type: "string",
            description: "Self-contained fact, one or two sentences.",
          },
          tags: {
            type: "string",
            description: "Comma-separated, optional",
          },
        },
        required: ["layer", "category", "content"],
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
