/**
 * Static tool definitions in OpenAI function-calling format
 * for the autonomous agent loop.
 */
import type { Tool } from "../../providers/types";

export const AGENT_TOOLS: Tool[] = [
  {
    type: "function",
    function: {
      name: "memory_search",
      description:
        "Search across memory layers (FTS5 full-text). Returns relevant memories.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          layer: {
            type: "string",
            enum: ["context", "archive", "shared", "all"],
            description: "Which layer to search (default: all)",
          },
          limit: {
            type: "number",
            description: "Max results (default: 10)",
          },
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
        "Create or update a memory entry. Use to save decisions, facts, plans.",
      parameters: {
        type: "object",
        properties: {
          layer: {
            type: "string",
            enum: ["focus", "context", "shared"],
            description: "Target memory layer",
          },
          content: { type: "string", description: "Content to store" },
          title: { type: "string", description: "Title (for context layer)" },
          tags: { type: "string", description: "Comma-separated tags" },
          category: {
            type: "string",
            description: "Category (for shared layer)",
          },
          key: {
            type: "string",
            description: "Key name (required for focus layer)",
          },
        },
        required: ["layer", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "rag_search",
      description:
        "Hybrid RAG search: FTS5 + vector → rerank. Best for finding relevant context. Costs 1-2 RPM.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          top_n: {
            type: "number",
            description: "Top N results after rerank (default: 5)",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "think",
      description:
        "Use this tool to think step-by-step about a complex problem before acting. Write your reasoning here. No side effects.",
      parameters: {
        type: "object",
        properties: {
          thought: {
            type: "string",
            description: "Your reasoning / chain of thought",
          },
        },
        required: ["thought"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "done",
      description:
        "Signal that you have completed the task. Include final summary for the user.",
      parameters: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            description: "Final result/summary for the user",
          },
        },
        required: ["summary"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "consult_specialists",
      description:
        "Consult other AI specialists in the team. Dispatches your question to selected specialists in parallel (Coder, Critic, Generalist, Chaos), collects their opinions, and synthesizes a combined answer. Use for complex decisions, code review, architecture questions, or when you need multiple expert perspectives. Costs 3-5 RPM.",
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "The question or task for the specialists",
          },
          context: {
            type: "string",
            description: "Additional context / background for the question",
          },
          specialists: {
            type: "array",
            items: {
              type: "string",
              enum: ["coder", "critic", "generalist", "chaos"],
            },
            description: "Which specialists to consult (default: all four)",
          },
          category: {
            type: "string",
            enum: ["code", "architecture", "review", "reasoning"],
            description:
              "Task category for weighting specialist responses (default: reasoning)",
          },
        },
        required: ["question"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_tool",
      description:
        "Create a new dynamic tool that you can use in subsequent steps. The tool will be a prompt template sent to a chosen specialist model. Use this to extend your capabilities on-the-fly for recurring sub-tasks. Max 10 dynamic tools per session.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description:
              "Tool name (lowercase, a-z0-9_, 2-49 chars). E.g. 'analyze_code_style'",
          },
          description: {
            type: "string",
            description: "What this tool does (shown to you in future steps)",
          },
          model: {
            type: "string",
            enum: ["coder", "critic", "generalist", "flash"],
            description:
              "Which specialist model runs this tool (default: flash)",
          },
          prompt_template: {
            type: "string",
            description:
              "System prompt for the specialist. Use {{input}} as placeholder for the caller's input.",
          },
          input_description: {
            type: "string",
            description:
              "Description of the 'input' parameter (shown in tool schema)",
          },
        },
        required: ["name", "description", "prompt_template"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_tools",
      description:
        "List all currently available dynamic tools (created during this session).",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
];
