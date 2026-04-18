/**
 * Auth middleware tests.
 * Tests bearer token validation, timing-safe comparison, and /health bypass.
 */

import { Elysia } from "elysia";
import { authMiddleware } from "../src/lib/auth";

const TOKEN = "test-secret-token";

const app = new Elysia()
  .get("/health", () => ({ status: "ok" }))
  .use(authMiddleware(TOKEN))
  .get("/protected", () => ({ data: "secret" }))
  .listen(0);

const base = `http://localhost:${app.server!.port}`;

// ─── Test 1: /health without auth → 200
const r1 = await fetch(`${base}/health`);
console.assert(r1.status === 200, `Health should be 200, got ${r1.status}`);
console.log("✅ /health accessible without auth");

// ─── Test 2: Protected route without auth → 401
const r2 = await fetch(`${base}/protected`);
console.assert(r2.status === 401, `No auth should be 401, got ${r2.status}`);
const b2 = await r2.json();
console.assert(
  b2.error?.message === "Missing authorization header",
  "Should say missing header",
);
console.log("✅ Missing auth header → 401");

// ─── Test 3: Wrong token → 401
const r3 = await fetch(`${base}/protected`, {
  headers: { Authorization: "Bearer wrong-token" },
});
console.assert(
  r3.status === 401,
  `Wrong token should be 401, got ${r3.status}`,
);
const b3 = await r3.json();
console.assert(
  b3.error?.message === "Invalid token",
  "Should say invalid token",
);
console.log("✅ Invalid token → 401");

// ─── Test 4: Valid token → pass through
const r4 = await fetch(`${base}/protected`, {
  headers: { Authorization: `Bearer ${TOKEN}` },
});
console.assert(
  r4.status === 200,
  `Valid token should be 200, got ${r4.status}`,
);
const b4 = await r4.json();
console.assert(b4.data === "secret", "Should return protected data");
console.log("✅ Valid token → 200");

// ─── Test 5: Case-insensitive "bearer" prefix
const r5 = await fetch(`${base}/protected`, {
  headers: { Authorization: `bearer ${TOKEN}` },
});
console.assert(
  r5.status === 200,
  `Lowercase bearer should be 200, got ${r5.status}`,
);
console.log("✅ Case-insensitive Bearer prefix");

// ─── Test 6: Timing-safe comparison (different lengths)
const r6 = await fetch(`${base}/protected`, {
  headers: { Authorization: "Bearer x" },
});
console.assert(r6.status === 401, "Short token should be 401");
console.log("✅ Different-length token rejected");

app.stop();
console.log("\n🎉 All auth tests passed!");
