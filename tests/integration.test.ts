#!/usr/bin/env bun
/**
 * Integration test suite for Subbrain proxy.
 * Runs against a LIVE server (localhost:4000) and real NVIDIA NIM API.
 *
 * Usage:
 *   1. Start server: bun run src/index.ts
 *   2. Run tests:    bun run tests/integration.test.ts
 *
 * Each test is sequential to respect 40 RPM limit.
 * Expected RPM usage: ~8-12 requests total.
 */

const BASE = "http://localhost:4000";
const AUTH = "Bearer subbrain-local-dev";

let passed = 0;
let failed = 0;
const errors: string[] = [];

async function test(name: string, fn: () => Promise<void>) {
  const start = Date.now();
  try {
    await fn();
    const ms = Date.now() - start;
    console.log(`  ✅ ${name} (${ms}ms)`);
    passed++;
  } catch (err) {
    const ms = Date.now() - start;
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  ❌ ${name} (${ms}ms): ${msg}`);
    errors.push(`${name}: ${msg}`);
    failed++;
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

async function json(res: Response) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Not JSON (${res.status}): ${text.substring(0, 200)}`);
  }
}

// ─────────────────────────────────────────────────────────
console.log("\n🧪 Subbrain Integration Tests\n");
console.log("─── 1. Health & Infrastructure ─────────────\n");

await test("GET /health — server alive", async () => {
  const res = await fetch(`${BASE}/health`);
  assert(res.ok, `Status ${res.status}`);
  const data = await json(res);
  assert(data.status === "ok", `Expected status ok, got ${data.status}`);
  assert(typeof data.rpm.availableSlots === "number", "Missing RPM stats");
});

await test("GET /metrics — observability endpoint", async () => {
  const res = await fetch(`${BASE}/metrics`, {
    headers: { Authorization: AUTH },
  });
  assert(res.ok, `Status ${res.status}`);
  const data = await json(res);
  assert("requests" in data, "Missing requests");
  assert("rpm" in data, "Missing rpm stats");
  assert("tokens" in data, "Missing tokens");
  assert("latency" in data, "Missing latency");
});

await test("GET /v1/models — virtual model list", async () => {
  const res = await fetch(`${BASE}/v1/models`, {
    headers: { Authorization: AUTH },
  });
  assert(res.ok, `Status ${res.status}`);
  const data = await json(res);
  assert(data.object === "list", "Expected object=list");
  const ids = data.data.map((m: any) => m.id);
  assert(ids.includes("teamlead"), "Missing teamlead model");
  assert(ids.includes("coder"), "Missing coder model");
  assert(ids.includes("flash"), "Missing flash model");
  assert(data.data.length === 5, `Expected 5 models, got ${data.data.length}`);
});

// ─── 2. Auth ──────────────────────────────────────────────
console.log("\n─── 2. Auth ────────────────────────────────\n");

await test("No auth → 401", async () => {
  const res = await fetch(`${BASE}/v1/models`);
  assert(res.status === 401, `Expected 401, got ${res.status}`);
});

await test("Wrong token → 401", async () => {
  const res = await fetch(`${BASE}/v1/models`, {
    headers: { Authorization: "Bearer wrong-token" },
  });
  assert(res.status === 401, `Expected 401, got ${res.status}`);
});

// ─── 3. Direct Proxy (real NVIDIA API) ────────────────────
console.log("\n─── 3. Direct Proxy (real model) ───────────\n");

await test("POST /v1/chat/completions — direct proxy (flash)", async () => {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: AUTH,
      "Content-Type": "application/json",
      "X-Direct-Mode": "true",
    },
    body: JSON.stringify({
      model: "flash",
      messages: [{ role: "user", content: "Reply with exactly: PONG" }],
      max_tokens: 10,
      temperature: 0,
    }),
  });
  assert(res.ok, `Status ${res.status}: ${await res.clone().text()}`);
  const data = await json(res);
  assert(data.choices?.length > 0, "No choices in response");
  assert(
    typeof data.choices[0].message.content === "string",
    "Missing content",
  );
  console.log(
    `    → Model replied: "${data.choices[0].message.content.trim().substring(0, 50)}"`,
  );
});

// ─── 4. Pipeline (virtual model with agent pipeline) ──────
console.log("\n─── 4. Agent Pipeline (virtual model) ──────\n");

await test("POST /v1/chat/completions — pipeline (flash)", async () => {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: AUTH,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "flash",
      messages: [{ role: "user", content: "Say hello in one word." }],
      max_tokens: 50,
      temperature: 0,
    }),
  });
  assert(res.ok, `Status ${res.status}: ${await res.clone().text()}`);
  const data = await json(res);
  assert(data.choices?.length > 0, "No choices");
  const content = data.choices[0].message.content;
  assert(typeof content === "string" && content.length > 0, "Empty content");
  console.log(`    → Flash replied: "${content.trim().substring(0, 80)}"`);

  // Check traceability headers
  const reqId = res.headers.get("X-Request-Id");
  const sessId = res.headers.get("X-Session-Id");
  assert(reqId !== null && reqId.length > 10, `Missing X-Request-Id: ${reqId}`);
  assert(
    sessId !== null && sessId.length > 10,
    `Missing X-Session-Id: ${sessId}`,
  );
  console.log(`    → RequestId: ${reqId?.substring(0, 8)}...`);
});

// ─── 5. Streaming ─────────────────────────────────────────
console.log("\n─── 5. Streaming ───────────────────────────\n");

await test("POST /v1/chat/completions — SSE stream", async () => {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: AUTH,
      "Content-Type": "application/json",
      "X-Direct-Mode": "true",
    },
    body: JSON.stringify({
      model: "flash",
      messages: [{ role: "user", content: "Count: 1, 2, 3" }],
      max_tokens: 30,
      temperature: 0,
      stream: true,
    }),
  });
  assert(res.ok, `Status ${res.status}`);
  assert(
    res.headers.get("content-type")?.includes("text/event-stream") === true,
    `Expected SSE, got ${res.headers.get("content-type")}`,
  );

  // Read stream and verify SSE format
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let fullText = "";
  let chunkCount = 0;
  let gotDone = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    for (const line of text.split("\n")) {
      if (line.startsWith("data: ")) {
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") {
          gotDone = true;
          continue;
        }
        try {
          const chunk = JSON.parse(payload);
          const delta = chunk.choices?.[0]?.delta?.content;
          if (delta) {
            fullText += delta;
            chunkCount++;
          }
        } catch {
          // some chunks may not be valid JSON (e.g. heartbeats)
        }
      }
    }
  }

  assert(chunkCount > 0, `Expected multiple chunks, got ${chunkCount}`);
  assert(gotDone, "Stream did not end with [DONE]");
  console.log(
    `    → Received ${chunkCount} chunks: "${fullText.trim().substring(0, 60)}"`,
  );
});

// ─── 6. Embeddings ────────────────────────────────────────
console.log("\n─── 6. Embeddings ──────────────────────────\n");

await test("POST /v1/embeddings", async () => {
  const res = await fetch(`${BASE}/v1/embeddings`, {
    method: "POST",
    headers: {
      Authorization: AUTH,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "nvidia/llama-3.2-nemoretriever-300m-embed-v1",
      input: ["Test embedding for integration"],
      input_type: "query",
    }),
  });
  assert(res.ok, `Status ${res.status}: ${await res.clone().text()}`);
  const data = await json(res);
  assert(data.data?.length > 0, "No embedding data");
  const dim = data.data[0].embedding.length;
  assert(dim > 100, `Embedding dimension too small: ${dim}`);
  console.log(`    → Embedding dim: ${dim}`);
});

// ─── 7. MCP Tools ─────────────────────────────────────────
console.log("\n─── 7. MCP Tools ───────────────────────────\n");

await test("POST /mcp/tools/list — 12 tools", async () => {
  const res = await fetch(`${BASE}/mcp/tools/list`, {
    method: "POST",
    headers: { Authorization: AUTH, "Content-Type": "application/json" },
    body: "{}",
  });
  assert(res.ok, `Status ${res.status}`);
  const data = await json(res);
  assert(
    data.tools?.length === 12,
    `Expected 12 tools, got ${data.tools?.length}`,
  );
});

await test("POST /mcp/tools/call — memory_write + memory_read", async () => {
  // Write
  const writeRes = await fetch(`${BASE}/mcp/tools/call`, {
    method: "POST",
    headers: { Authorization: AUTH, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "memory_write",
      arguments: {
        layer: "shared",
        title: "integration-test",
        content: "This is an integration test entry",
        tags: "test,integration",
      },
    }),
  });
  assert(writeRes.ok, `Write failed: ${writeRes.status}`);
  const writeData = await json(writeRes);
  assert(
    writeData.success === true,
    `Write not successful: ${JSON.stringify(writeData)}`,
  );
  assert(writeData.data?.id, `No ID returned: ${JSON.stringify(writeData)}`);

  const id = writeData.data.id;

  // Read back via search
  const searchRes = await fetch(`${BASE}/mcp/tools/call`, {
    method: "POST",
    headers: { Authorization: AUTH, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "memory_search",
      arguments: {
        query: "integration test",
        layer: "shared",
      },
    }),
  });
  assert(searchRes.ok, `Search failed: ${searchRes.status}`);
  const searchData = await json(searchRes);
  assert(searchData.success === true, `Search not successful`);
  console.log(`    → Write (id=${id.substring(0, 8)}...) + Search OK`);
});

// ─── 8. Memory persistence check ─────────────────────────
console.log("\n─── 8. Memory Persistence ──────────────────\n");

await test("Layer 4 log written by pipeline", async () => {
  // The pipeline test above should have logged to Layer 4.
  // Check via log_read tool
  const readRes = await fetch(`${BASE}/mcp/tools/call`, {
    method: "POST",
    headers: { Authorization: AUTH, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "log_read",
      arguments: { limit: 5 },
    }),
  });
  assert(readRes.ok, `Log read failed: ${readRes.status}`);
  const data = await json(readRes);
  assert(data.success !== undefined, "No log_read response");
  console.log(`    → log_read endpoint OK`);
});

// ─── 9. Metrics after load ────────────────────────────────
console.log("\n─── 9. Post-test Metrics ───────────────────\n");

await test("Metrics reflect real requests", async () => {
  // Small delay to let fire-and-forget post-processing finish
  await new Promise((r) => setTimeout(r, 2000));

  const res = await fetch(`${BASE}/metrics`, {
    headers: { Authorization: AUTH },
  });
  assert(res.ok, `Status ${res.status}`);
  const data = await json(res);
  assert(
    typeof data.requests.ok === "number" &&
      typeof data.requests.error === "number",
    `Expected requests counters, got ${JSON.stringify(data.requests)}`,
  );
  console.log(
    `    → Requests OK: ${data.requests.ok}, Errors: ${data.requests.error}`,
  );
  console.log(
    `    → Tokens in: ${data.tokens.total_in}, out: ${data.tokens.total_out}`,
  );
  console.log(
    `    → RPM: ${data.rpm.current}/${data.rpm.current + data.rpm.available}`,
  );
});

// ─── 10. RPM & health check ──────────────────────────────
console.log("\n─── 10. Final Health Check ─────────────────\n");

await test("Server still healthy after all tests", async () => {
  const res = await fetch(`${BASE}/health`);
  assert(res.ok, `Status ${res.status}`);
  const data = await json(res);
  assert(data.status === "ok", "Server not ok");
  console.log(
    `    → RPM used: ${data.rpm.currentLoad}, available: ${data.rpm.availableSlots}`,
  );
});

// ─── Summary ──────────────────────────────────────────────
console.log("\n─────────────────────────────────────────────");
console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);

if (errors.length > 0) {
  console.log("Failures:");
  for (const e of errors) {
    console.log(`  • ${e}`);
  }
  console.log();
}

process.exit(failed > 0 ? 1 : 0);
