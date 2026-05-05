/**
 * AUTH-16 — auth-coverage regression test (PR 17).
 *
 * Asserts every sensitive endpoint is gated by Bearer auth and the public
 * surface stays reachable. Runs against an in-memory Elysia built from
 * `createApp()` with a fake deps bundle — no live server, no network.
 *
 * Covered scenarios (plan §Тесты):
 *   1.  GET  /api/token                        (no auth)  → 401
 *   2.  GET  /api/token                        (bearer)   → 200 + token
 *   3.  POST /night-cycle                      (no auth)  → 401
 *   4.  GET  /night-cycle/status               (no auth)  → 401
 *   5.  POST /telegram/set-webhook             (no auth)  → 401
 *   6.  POST /telegram/remove-webhook          (no auth)  → 401
 *   7.  POST /telegram/webhook                 (no sec)   → 401
 *   8.  POST /telegram/webhook                 (sec hdr)  → 200
 *   9.  GET  /health                           (no auth)  → 200
 *   10. GET  /                                 (no auth)  → 200
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createApp } from "../src/app/bootstrap";
import type { AppConfig, AppDeps } from "../src/app/deps";
import { MemoryDB } from "../src/db";
import { Metrics } from "../src/lib/metrics";
import { AuthService } from "@subbrain/core/services/auth";
import type { TelegramBot } from "../src/telegram";

const TEST_DB = "data/test-auth-coverage.db";
const TOKEN = "test-auth-token";
const SECRET = "test-webhook-secret";

try {
  unlinkSync(TEST_DB);
} catch {}

// Minimal static index so `GET /` goes through staticPlugin → 200.
// Must exist BEFORE `createApp()` runs (staticPlugin scans `public/` on init,
// not per request), hence module-top-level setup rather than `beforeAll`.
const INDEX_PATH = "public/index.html";
let createdPublic = false;
let createdIndex = false;
let originalIndex: string | null = null;

if (!existsSync("public")) {
  mkdirSync("public");
  createdPublic = true;
}
if (existsSync(INDEX_PATH)) {
  originalIndex = readFileSync(INDEX_PATH, "utf8");
} else {
  createdIndex = true;
}
writeFileSync(INDEX_PATH, "<!doctype html><title>test</title>\n");

function restorePublic() {
  if (createdIndex) {
    try {
      unlinkSync(INDEX_PATH);
    } catch {}
  } else if (originalIndex !== null) {
    writeFileSync(INDEX_PATH, originalIndex);
  }
  if (createdPublic) {
    try {
      // best-effort; public/ may be re-populated by other tests
      require("node:fs").rmdirSync("public");
    } catch {}
  }
}

// ── Fakes ──────────────────────────────────────────────────────────────────

/**
 * Stub TelegramBot — only surfaces the methods `telegramPublicRoute` /
 * `telegramAdminRoute` touch: `webhookSecret`, `bot.handleUpdate`,
 * `setWebhook`, `removeWebhook`.
 */
function buildFakeBot(): TelegramBot {
  return {
    webhookSecret: SECRET,
    bot: { handleUpdate: async () => undefined },
    setWebhook: async (_url: string) => undefined,
    removeWebhook: async () => undefined,
  } as unknown as TelegramBot;
}

function buildDeps(): AppDeps {
  const memory = new MemoryDB(TEST_DB);
  const routerStats = { currentLoad: 0, queueLength: 0, availableSlots: 40 };
  const router = {
    stats: routerStats,
    get isOverloaded() {
      return false;
    },
  } as any;
  const metrics = new Metrics({
    get currentLoad() {
      return routerStats.currentLoad;
    },
    get queueLength() {
      return routerStats.queueLength;
    },
    get availableSlots() {
      return routerStats.availableSlots;
    },
  });
  const config: AppConfig = {
    port: 4000,
    authToken: TOKEN,
    dbPath: TEST_DB,
    autonomous: {
      enabled: false,
      intervalMinutes: 30,
      startupDelayMs: 0,
      maxSteps: 100,
      task: "",
    },
    nightCycle: { schedulerEnabled: false, hourUtc: 3, backlogTrigger: 100 },
    telegram: { webhookUrl: undefined, polling: false },
    telegramPoller: {
      enabled: false,
      remindChatId: "",
      pollIntervalMs: 60_000,
      remindIntervalMs: 60_000,
      staleHours: 6,
      remindModel: "flash",
    },
    freelance: {
      enabled: false,
      pollMs: 60_000,
      categories: [],
      minBudget: 0,
      maxBudget: 0,
      threshold: 7,
      tgChatId: null,
    },
    freeAgent: {
      enabled: false,
      intervalMinutes: 60,
      startupDelayMs: 0,
      maxSteps: 50,
      task: "",
    },
  };
  return {
    config,
    authService: new AuthService(TOKEN),
    memory,
    router,
    rag: {} as any,
    tools: {} as any,
    registry: { list: () => [], get: () => undefined } as any,
    playwright: {} as any,
    metrics,
    pipeline: {} as any,
    room: {} as any,
    nightCycle: {} as any,
    agentLoop: {} as any,
    telegramBot: buildFakeBot(),
    userbot: null,
    telegramPoller: null,
    freelanceScout: null,
  };
}

// ── Suite ──────────────────────────────────────────────────────────────────

describe("auth coverage (AUTH-16 / PR 17)", () => {
  const deps = buildDeps();
  const { app } = createApp(deps);
  // Live listen on an ephemeral port — staticPlugin only wires up its routes
  // once the server starts listening, so `app.handle()` returns 404 for `/`
  // even if `public/index.html` exists. The auth check still fires either
  // way; we use a live fetch so the "GET / → 200" assertion is realistic.
  app.listen(0);
  const base = `http://localhost:${app.server?.port}`;

  afterAll(async () => {
    await app.stop();
    deps.memory.close();
    restorePublic();
  });

  const req = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
    fetch(`${base}${path}`, init);

  // ── protected endpoints — no auth → 401 ──────────────────────────────────

  test("GET /api/token without auth → 401", async () => {
    const r = await req("/api/token");
    expect(r.status).toBe(401);
  });

  test("POST /night-cycle without auth → 401", async () => {
    const r = await req("/night-cycle", { method: "POST" });
    expect(r.status).toBe(401);
  });

  test("GET /night-cycle/status without auth → 401", async () => {
    const r = await req("/night-cycle/status");
    expect(r.status).toBe(401);
  });

  test("POST /telegram/set-webhook without auth → 401", async () => {
    const r = await req("/telegram/set-webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://evil.example.com/hook" }),
    });
    expect(r.status).toBe(401);
  });

  test("POST /telegram/remove-webhook without auth → 401", async () => {
    const r = await req("/telegram/remove-webhook", { method: "POST" });
    expect(r.status).toBe(401);
  });

  // ── protected endpoints — with auth → 200 ────────────────────────────────

  test("GET /api/token with valid Bearer → 200 + token body", async () => {
    const r = await req("/api/token", {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { token: string };
    expect(body.token).toBe(TOKEN);
  });

  // ── telegram webhook — secret-header gate (handler-level) ────────────────

  test("POST /telegram/webhook without secret header → 401", async () => {
    const r = await req("/telegram/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ update_id: 1 }),
    });
    expect(r.status).toBe(401);
  });

  test("POST /telegram/webhook with valid secret → 200", async () => {
    const r = await req("/telegram/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-telegram-bot-api-secret-token": SECRET,
      },
      body: JSON.stringify({ update_id: 1 }),
    });
    expect(r.status).toBe(200);
  });

  // ── public surface — stays reachable without auth ────────────────────────

  test("GET /health without auth → 200", async () => {
    const r = await req("/health");
    expect(r.status).toBe(200);
    const body = (await r.json()) as { status: string };
    expect(body.status).toBe("ok");
  });

  test("GET / (static index) without auth → 200", async () => {
    const r = await req("/");
    expect(r.status).toBe(200);
  });
});
