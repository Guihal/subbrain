/**
 * Raw log (Layer 4) + history compression.
 */
import { type ToolRegistry, t } from "./tool-registry";

export function registerLogTools(registry: ToolRegistry): void {
  registry.register({
    name: "log_append",
    description: "Append an entry to the raw log (Layer 4).",
    scope: "public",
    input: t.Object({
      request_id: t.String(),
      session_id: t.String(),
      agent_id: t.String(),
      role: t.Union([
        t.Literal("user"),
        t.Literal("assistant"),
        t.Literal("system"),
        t.Literal("tool"),
      ]),
      content: t.String(),
      token_count: t.Optional(t.Number()),
    }),
    handler: (args, ctx) =>
      ctx.executor.logTools.append(
        args.request_id,
        args.session_id,
        args.agent_id,
        args.role,
        args.content,
        args.token_count,
      ),
  });

  registry.register({
    name: "log_read",
    description: "Read raw log entries for a session or request.",
    scope: "public",
    input: t.Object({
      session_id: t.Optional(t.String()),
      request_id: t.Optional(t.String()),
      limit: t.Optional(t.Number()),
    }),
    handler: (args, ctx) =>
      ctx.executor.logTools.read(args.session_id, args.request_id, args.limit),
  });

  registry.register({
    name: "compress_history",
    description: "Compress chat history into a concise markdown summary.",
    scope: "public",
    input: t.Object({
      messages: t.Array(
        t.Object({
          role: t.Union([
            t.Literal("user"),
            t.Literal("assistant"),
            t.Literal("system"),
            t.Literal("tool"),
          ]),
          content: t.String(),
        }),
      ),
    }),
    handler: (args, ctx) => ctx.executor.logTools.compressHistory(args.messages),
  });
}
