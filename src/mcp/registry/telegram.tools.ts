/**
 * Telegram-тулы. MTProto-userbot для чтения, grammy-бот для отправки.
 */
import { t, type ToolRegistry } from "./tool-registry";

export function registerTelegramTools(registry: ToolRegistry): void {
  registry.register({
    name: "tg_list_chats",
    description:
      "List user's Telegram chats (dialogs). Returns chat name, ID, type, unread count.",
    scope: "public",
    input: t.Object({
      limit: t.Optional(
        t.Number({ description: "Max number of chats (default: 100)" }),
      ),
    }),
    handler: (args, ctx) => ctx.executor.tgListChats(args.limit),
  });

  registry.register({
    name: "tg_read_chat",
    description:
      "Read messages from a specific Telegram chat by ID. Returns recent messages with sender, text, date.",
    scope: "public",
    input: t.Object({
      chat_id: t.String({ description: "Chat ID (from tg_list_chats)" }),
      limit: t.Optional(
        t.Number({ description: "Max messages (default: 50)" }),
      ),
      offset_id: t.Optional(
        t.Number({ description: "Message ID to paginate from" }),
      ),
    }),
    handler: (args, ctx) =>
      ctx.executor.tgReadChat(args.chat_id, args.limit, args.offset_id),
  });

  registry.register({
    name: "tg_search_messages",
    description:
      "Search messages across all chats or within a specific chat. FTS by text content.",
    scope: "public",
    input: t.Object({
      query: t.String(),
      limit: t.Optional(t.Number({ description: "Max results (default: 30)" })),
      chat_id: t.Optional(
        t.String({ description: "Optional chat ID to search within" }),
      ),
    }),
    handler: (args, ctx) =>
      ctx.executor.tgSearchMessages(args.query, args.limit, args.chat_id),
  });

  registry.register({
    name: "tg_exclude_chat",
    description:
      "Exclude a chat from being read (e.g. private/sensitive). Skipped in tg_list_chats.",
    scope: "public",
    input: t.Object({
      chat_id: t.String(),
      chat_title: t.String(),
      reason: t.Optional(t.String({ description: "Reason (default: private)" })),
    }),
    handler: (args, ctx) =>
      ctx.executor.tgExcludeChat(args.chat_id, args.chat_title, args.reason),
  });

  registry.register({
    name: "tg_include_chat",
    description:
      "Re-include a previously excluded chat (undo tg_exclude_chat).",
    scope: "public",
    input: t.Object({
      chat_id: t.String(),
    }),
    handler: (args, ctx) => ctx.executor.tgIncludeChat(args.chat_id),
  });

  registry.register({
    name: "tg_list_excluded",
    description: "List all excluded Telegram chats.",
    scope: "public",
    input: t.Object({}),
    handler: (_args, ctx) => ctx.executor.tgListExcluded(),
  });

  registry.register({
    name: "telegram_search",
    description:
      "Full-text search of indexed Telegram messages (FTS5). Filter by chat_id and time range.",
    scope: "public",
    input: t.Object({
      query: t.String(),
      chat_id: t.Optional(t.String()),
      from: t.Optional(
        t.String({ description: "ISO date, inclusive lower bound on message time" }),
      ),
      to: t.Optional(
        t.String({ description: "ISO date, inclusive upper bound on message time" }),
      ),
      limit: t.Optional(t.Number({ description: "Max results (default 20, max 200)" })),
    }),
    handler: (args, ctx) =>
      ctx.executor.tgFtsSearch(
        args.query,
        args.chat_id,
        args.from,
        args.to,
        args.limit,
      ),
  });

  registry.register({
    name: "tg_send_message",
    description:
      "Send a message to the user via Telegram. Use for summaries, reports, notifications, alerts. Supports Markdown. Max ~4000 chars.",
    scope: "public",
    input: t.Object({
      text: t.String(),
    }),
    handler: (args, ctx) => ctx.executor.tgSendMessage(args.text),
  });
}
