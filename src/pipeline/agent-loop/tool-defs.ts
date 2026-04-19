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

  // ─── Telegram ─────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "tg_list_chats",
      description:
        "List user's Telegram chats (dialogs). Returns chat name, ID, type, unread count. Use to discover which chats to read.",
      parameters: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Max number of chats to return (default: 100)",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "tg_read_chat",
      description:
        "Read messages from a specific Telegram chat by ID. Returns recent messages with sender, text, date.",
      parameters: {
        type: "object",
        properties: {
          chat_id: {
            type: "string",
            description: "Chat ID (from tg_list_chats)",
          },
          limit: {
            type: "number",
            description: "Max messages to return (default: 50)",
          },
          offset_id: {
            type: "number",
            description: "Message ID to paginate from (for older messages)",
          },
        },
        required: ["chat_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "tg_search_messages",
      description:
        "Search messages across all chats or within a specific chat. FTS search by text content.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          limit: {
            type: "number",
            description: "Max results (default: 30)",
          },
          chat_id: {
            type: "string",
            description: "Optional chat ID to search within",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "tg_exclude_chat",
      description:
        "Exclude a chat from being read (e.g. private/sensitive). Will be skipped in tg_list_chats.",
      parameters: {
        type: "object",
        properties: {
          chat_id: { type: "string", description: "Chat ID to exclude" },
          chat_title: {
            type: "string",
            description: "Chat title (for reference)",
          },
          reason: {
            type: "string",
            description: "Reason for exclusion (default: private)",
          },
        },
        required: ["chat_id", "chat_title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "tg_include_chat",
      description:
        "Re-include a previously excluded chat (undo tg_exclude_chat).",
      parameters: {
        type: "object",
        properties: {
          chat_id: {
            type: "string",
            description: "Chat ID to re-include",
          },
        },
        required: ["chat_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "tg_list_excluded",
      description: "List all excluded Telegram chats.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "tg_send_message",
      description:
        "Send a message to the user via Telegram. Use for summaries, reports, notifications, alerts, or any proactive communication. Supports Markdown formatting.",
      parameters: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description:
              "Message text (Markdown supported). Max ~4000 chars.",
          },
        },
        required: ["text"],
      },
    },
  },

  // ─── Web Browsing Tools (Playwright MCP) ─────────────────
  {
    type: "function",
    function: {
      name: "web_navigate",
      description:
        "Navigate to a URL in the browser and return the page content (accessibility snapshot). Use to visit websites, read articles, research topics, check prices.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to navigate to" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_snapshot",
      description:
        "Get the current page content as an accessibility tree. Use after clicking or interacting to read updated page state.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_click",
      description:
        "Click an element on the page by its ref number (from snapshot). Use to follow links, press buttons, interact with page elements.",
      parameters: {
        type: "object",
        properties: {
          element: { type: "string", description: "Human-readable element description" },
          ref: { type: "string", description: "Exact ref number from the page snapshot" },
        },
        required: ["element", "ref"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_type",
      description:
        "Type text into an input field on the page. Use for search forms, login fields, etc.",
      parameters: {
        type: "object",
        properties: {
          element: { type: "string", description: "Human-readable element description" },
          ref: { type: "string", description: "Exact ref number from the page snapshot" },
          text: { type: "string", description: "Text to type" },
          submit: { type: "boolean", description: "Press Enter after typing (default: false)" },
        },
        required: ["element", "ref", "text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_back",
      description: "Go back to the previous page in browser history.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_press_key",
      description: "Press a keyboard key in the browser (e.g. Enter, Escape, Tab, ArrowDown).",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "Key to press (e.g. 'Enter', 'Escape', 'Tab')" },
        },
        required: ["key"],
      },
    },
  },
];
