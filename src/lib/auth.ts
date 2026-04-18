import { Elysia } from "elysia";
import { timingSafeEqual } from "crypto";

const JSON_401 = { "Content-Type": "application/json" };

/** Constant-time string comparison to prevent timing attacks. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function authMiddleware(token: string) {
  return new Elysia({ name: "auth" }).onBeforeHandle(
    { as: "global" },
    ({ request, path }) => {
      // Health check and static assets are public
      if (path === "/health") return;
      if (path === "/" || path === "/index.html" || path.startsWith("/public/"))
        return;
      // Token endpoint is protected by Caddy basic auth, not Bearer
      if (path === "/api/token") return;
      // Telegram webhook is validated by secret_token header (grammy handles it)
      if (path.startsWith("/telegram/")) return;

      const auth = request.headers.get("authorization");
      if (!auth) {
        return new Response(
          JSON.stringify({
            error: { message: "Missing authorization header" },
          }),
          { status: 401, headers: JSON_401 },
        );
      }

      const bearer = auth.replace(/^Bearer\s+/i, "");
      if (!safeEqual(bearer, token)) {
        return new Response(
          JSON.stringify({ error: { message: "Invalid token" } }),
          { status: 401, headers: JSON_401 },
        );
      }
    },
  );
}
