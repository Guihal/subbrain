import { Elysia, t } from "elysia";
import type { MemoryDB } from "../db";

export function chatsRoute(memory: MemoryDB) {
  return new Elysia({ prefix: "/v1/chats" })
    .get("/", ({ query }) => {
      const source = query.source as string | undefined;
      const limit = Number(query.limit) || 50;
      return memory.listChats(limit, source);
    })
    .get("/:id", ({ params }) => {
      const chat = memory.getChat(params.id);
      if (!chat) {
        return new Response(
          JSON.stringify({ error: { message: "Chat not found" } }),
          { status: 404, headers: { "Content-Type": "application/json" } },
        );
      }
      return chat;
    })
    .get("/:id/messages", ({ params }) => {
      const chat = memory.getChat(params.id);
      if (!chat) {
        return new Response(
          JSON.stringify({ error: { message: "Chat not found" } }),
          { status: 404, headers: { "Content-Type": "application/json" } },
        );
      }
      return memory.getChatMessages(params.id);
    })
    .post(
      "/",
      ({ body }) => {
        const id = crypto.randomUUID();
        memory.createChat(
          id,
          body.title || "Новый чат",
          body.model || "teamlead",
          body.source || "web",
        );
        return memory.getChat(id);
      },
      {
        body: t.Object({
          title: t.Optional(t.String()),
          model: t.Optional(t.String()),
          source: t.Optional(t.String()),
        }),
      },
    )
    .patch(
      "/:id",
      ({ params, body }) => {
        const chat = memory.getChat(params.id);
        if (!chat) {
          return new Response(
            JSON.stringify({ error: { message: "Chat not found" } }),
            { status: 404, headers: { "Content-Type": "application/json" } },
          );
        }
        if (body.title) {
          memory.updateChatTitle(params.id, body.title);
        }
        if (body.model) {
          memory.updateChatModel(params.id, body.model);
        }
        return memory.getChat(params.id);
      },
      {
        body: t.Object({
          title: t.Optional(t.String()),
          model: t.Optional(t.String()),
        }),
      },
    )
    .delete("/:id", ({ params }) => {
      memory.deleteChat(params.id);
      return { ok: true };
    });
}
