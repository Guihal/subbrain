import { afterAll, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { authMiddleware } from "../src/lib/auth";
import { AuthService } from "../src/services/auth.service";

const TOKEN = "test-secret-token";
const app = new Elysia()
  .get("/health", () => ({ status: "ok" }))
  .use(authMiddleware(new AuthService(TOKEN)))
  .get("/protected", () => ({ data: "secret" }))
  .listen(0);
const base = `http://localhost:${app.server?.port}`;

afterAll(() => app.stop());

describe("authMiddleware", () => {
  test("/health accessible without auth", async () => {
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });

  test("missing auth header → 401", async () => {
    const r = await fetch(`${base}/protected`);
    expect(r.status).toBe(401);
    expect((await r.json()).error?.message).toBe("Unauthorized");
  });

  test("wrong token same length → 401", async () => {
    const wrong = `${TOKEN.slice(0, -1)}X`;
    const r = await fetch(`${base}/protected`, {
      headers: { Authorization: `Bearer ${wrong}` },
    });
    expect(r.status).toBe(401);
  });

  test("wrong token different length → 401 (no throw)", async () => {
    const r = await fetch(`${base}/protected`, {
      headers: { Authorization: "Bearer x" },
    });
    expect(r.status).toBe(401);
  });

  test("empty string token → 401", async () => {
    const r = await fetch(`${base}/protected`, {
      headers: { Authorization: "Bearer " },
    });
    expect(r.status).toBe(401);
  });

  test("valid token → 200", async () => {
    const r = await fetch(`${base}/protected`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(r.status).toBe(200);
    expect((await r.json()).data).toBe("secret");
  });

  test("case-insensitive Bearer prefix", async () => {
    const r = await fetch(`${base}/protected`, {
      headers: { Authorization: `bearer ${TOKEN}` },
    });
    expect(r.status).toBe(200);
  });
});
