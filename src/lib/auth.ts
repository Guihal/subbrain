import { Elysia } from "elysia";
import type { AuthService } from "../services/auth.service";

const JSON_401 = { "Content-Type": "application/json" };

/**
 * Bearer auth middleware. Delegates all hash/compare work to `AuthService`
 * — this file only owns the HTTP framing (path allow-list + 401 shape).
 *
 * Public bypasses:
 *   - `/health`, `/`, `/index.html`, `/public/*` — static + liveness.
 *   - `/telegram/webhook` — validated by `x-telegram-bot-api-secret-token`
 *     inside the route handler. Admin endpoints (set/remove webhook) stay
 *     behind Bearer auth — AUTH-16 narrowed the bypass from `/telegram/*`
 *     to the single webhook path; do not widen it again.
 *   - `/api/token` used to be bypassed (relying on Caddy basic-auth) but
 *     AUTH-16 found it exposed the Bearer secret to anyone with port
 *     access, so it now requires Bearer like every other route.
 */
export function authMiddleware(authService: AuthService) {
  return new Elysia({ name: "auth" }).onBeforeHandle({ as: "global" }, ({ request, path }) => {
    if (path === "/health") return;
    if (path === "/" || path === "/index.html" || path.startsWith("/public/")) return;
    if (path === "/telegram/webhook") return;

    const header = request.headers.get("authorization");
    if (!authService.validateBearer(header)) {
      return new Response(JSON.stringify({ error: { message: "Unauthorized" } }), {
        status: 401,
        headers: JSON_401,
      });
    }
    return;
  });
}
