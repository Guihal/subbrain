/**
 * B-1: cross-agent context isolation.
 *
 * Verifies that `searchContext` / `getContextMany` filter `layer2_context`
 * rows by the caller's `agentId` (with `agent_id IS NULL` rows visible to
 * everyone — legacy "shared" back-compat). Admin scope (no agentId) sees
 * everything. Writer-side: hippocampus-style writes via `insertContext`
 * tag the row, and a sibling agent's scoped read does NOT pick it up.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { MemoryTools } from "@subbrain/agent/mcp/tools/memory";
import { sanitizeAgentId } from "@subbrain/agent/services/chat";
import { MemoryDB } from "@subbrain/core/db";

const TEST_DB = "data/test.db.b1";

let db: MemoryDB;
const ALICE_ID = randomUUID();
const BOB_ID = randomUUID();
const NULL_ID = randomUUID();

beforeAll(() => {
  try {
    unlinkSync(TEST_DB);
  } catch {}
  db = new MemoryDB(TEST_DB);

  // Three context rows that all match the FTS query "isolation":
  //  - alice's private row (agent_id = "alice")
  //  - bob's private row   (agent_id = "bob")
  //  - legacy/global row   (agent_id = NULL)
  db.insertContext(ALICE_ID, "alice's note", "secret isolation alice payload", "", [], "alice", {
    confidence: 1,
    status: "active",
  });
  db.insertContext(BOB_ID, "bob's note", "secret isolation bob payload", "", [], "bob", {
    confidence: 1,
    status: "active",
  });
  db.insertContext(NULL_ID, "legacy note", "shared isolation legacy payload", "", [], undefined, {
    confidence: 1,
    status: "active",
  });
});

afterAll(() => {
  db.close();
  try {
    unlinkSync(TEST_DB);
  } catch {}
});

describe("B-1: searchContext agent_id filter", () => {
  test("agentId='alice' → alice + NULL rows; bob hidden", () => {
    const hits = db.searchContext("isolation", 10, { agentId: "alice" });
    const ids = new Set(hits.map((h) => h.id));
    expect(ids.has(ALICE_ID)).toBe(true);
    expect(ids.has(NULL_ID)).toBe(true);
    expect(ids.has(BOB_ID)).toBe(false);
  });

  test("agentId='bob' → bob + NULL rows; alice hidden", () => {
    const hits = db.searchContext("isolation", 10, { agentId: "bob" });
    const ids = new Set(hits.map((h) => h.id));
    expect(ids.has(BOB_ID)).toBe(true);
    expect(ids.has(NULL_ID)).toBe(true);
    expect(ids.has(ALICE_ID)).toBe(false);
  });

  test("no agentId (admin scope) → all three rows visible", () => {
    const hits = db.searchContext("isolation", 10);
    const ids = new Set(hits.map((h) => h.id));
    expect(ids.has(ALICE_ID)).toBe(true);
    expect(ids.has(BOB_ID)).toBe(true);
    expect(ids.has(NULL_ID)).toBe(true);
  });

  test("activeOnly + agentId combine — both clauses applied", () => {
    // Add a pending row for alice that should not appear under activeOnly.
    const pendingId = randomUUID();
    db.insertContext(pendingId, "pending alice", "isolation pending alice", "", [], "alice", {
      confidence: 0.5,
      status: "pending",
    });
    const hits = db.searchContext("isolation", 10, {
      agentId: "alice",
      activeOnly: true,
    });
    const ids = new Set(hits.map((h) => h.id));
    expect(ids.has(ALICE_ID)).toBe(true); // active alice row
    expect(ids.has(NULL_ID)).toBe(true); // active legacy row
    expect(ids.has(pendingId)).toBe(false); // filtered by activeOnly
  });
});

describe("B-1: getContextMany agent_id filter", () => {
  test("agentId='alice' over [alice, bob, NULL] → alice + NULL only", () => {
    const rows = db.getContextMany([ALICE_ID, BOB_ID, NULL_ID], {
      agentId: "alice",
    });
    const ids = new Set(rows.map((r) => r.id));
    expect(ids.has(ALICE_ID)).toBe(true);
    expect(ids.has(NULL_ID)).toBe(true);
    expect(ids.has(BOB_ID)).toBe(false);
  });

  test("no agentId (admin) → returns all three rows", () => {
    const rows = db.getContextMany([ALICE_ID, BOB_ID, NULL_ID]);
    expect(rows.length).toBe(3);
  });
});

describe("B-1: MemoryTools.write enforces server-controlled agentId", () => {
  test("context insert ignores LLM-supplied params.agent_id; uses server agentId", () => {
    const tools = new MemoryTools(db, () => null);
    const id = randomUUID();
    // LLM tries to spoof — params.agent_id="bob" but server says "alice".
    tools.write(
      {
        layer: "context",
        id,
        title: "spoof attempt",
        content: "writer-isolation spoof payload",
        confidence: 1,
        agent_id: "bob",
      },
      "alice",
    );
    // Bob's scoped read MUST NOT see the row even though args.agent_id was "bob".
    const bobHits = db.searchContext("writer-isolation", 10, { agentId: "bob" });
    expect(bobHits.find((h) => h.id === id)).toBeUndefined();
    // Alice's scoped read DOES see it (it's her row, server-tagged).
    const aliceHits = db.searchContext("writer-isolation", 10, {
      agentId: "alice",
    });
    expect(aliceHits.find((h) => h.id === id)).toBeDefined();
  });

  test("agent layer requires server-bound agentId; rejects when null", () => {
    const tools = new MemoryTools(db, () => null);
    const result = tools.write(
      { layer: "agent", content: "should-fail", agent_id: "bob" },
      null, // server says: unscoped/admin → cannot write into agent bucket
    );
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain("server-bound agentId");
  });
});

describe("B-1: MemoryTools.write/delete ownership check (context)", () => {
  test("write UPDATE rejects when row owned by another agent", () => {
    const tools = new MemoryTools(db, () => null);
    const id = randomUUID();
    // Bob writes a context row.
    tools.write({ layer: "context", id, content: "owner-check bob payload", confidence: 1 }, "bob");
    // Alice tries to overwrite by guessing the id.
    const w = tools.write(
      { layer: "context", id, content: "hijack attempt", confidence: 1 },
      "alice",
    );
    expect(w.success).toBe(false);
    expect(String(w.error)).toContain("owned by another agent");
    // Bob's row content is unchanged.
    const bobRow = db.getContext(id);
    expect(bobRow?.content).toBe("owner-check bob payload");
  });

  test("write UPDATE accepts NULL legacy row from any agent (back-compat)", () => {
    const tools = new MemoryTools(db, () => null);
    const id = randomUUID();
    db.insertContext(id, "legacy", "owner-check legacy payload", "", [], undefined, {
      confidence: 1,
      status: "active",
    });
    // Alice can update a legacy NULL-agent row.
    const w = tools.write(
      { layer: "context", id, content: "alice updated legacy", confidence: 1 },
      "alice",
    );
    expect(w.success).toBe(true);
  });

  test("delete rejects cross-agent context row", () => {
    const tools = new MemoryTools(db, () => null);
    const id = randomUUID();
    tools.write(
      { layer: "context", id, content: "delete-check carol payload", confidence: 1 },
      "carol",
    );
    const d = tools.delete(id, "context", "dave");
    expect(d.success).toBe(false);
    expect(String(d.error)).toContain("owned by another agent");
    expect(db.getContext(id)).not.toBeNull();
  });

  test("delete admin (agentId=null) bypasses ownership", () => {
    const tools = new MemoryTools(db, () => null);
    const id = randomUUID();
    tools.write({ layer: "context", id, content: "delete-check admin", confidence: 1 }, "carol");
    const d = tools.delete(id, "context", null);
    expect(d.success).toBe(true);
    expect(db.getContext(id)).toBeNull();
  });
});

describe("B-1: sanitizeAgentId charset/length validation", () => {
  test("accepts valid identifiers (lowercase-normalized)", () => {
    expect(sanitizeAgentId("alice")).toBe("alice");
    expect(sanitizeAgentId("free-agent")).toBe("free-agent");
    expect(sanitizeAgentId("user_42")).toBe("user_42");
    // Mixed case is normalized to lowercase to prevent split buckets.
    expect(sanitizeAgentId("AUTONOMOUS")).toBe("autonomous");
    expect(sanitizeAgentId("Alice")).toBe("alice");
  });

  test("rejects empty / whitespace / null / undefined", () => {
    expect(sanitizeAgentId(undefined)).toBeNull();
    expect(sanitizeAgentId(null)).toBeNull();
    expect(sanitizeAgentId("")).toBeNull();
    expect(sanitizeAgentId("   ")).toBeNull();
  });

  test("rejects forbidden chars (SQL/log injection surface)", () => {
    expect(sanitizeAgentId("'; DROP TABLE")).toBeNull();
    expect(sanitizeAgentId("a/b")).toBeNull();
    expect(sanitizeAgentId("a b")).toBeNull();
    expect(sanitizeAgentId("привет")).toBeNull();
    expect(sanitizeAgentId("a\nb")).toBeNull();
  });

  test("rejects > 64 chars", () => {
    expect(sanitizeAgentId("a".repeat(64))).toBe("a".repeat(64));
    expect(sanitizeAgentId("a".repeat(65))).toBeNull();
  });

  test("rejects identifier starting with non-alphanumeric", () => {
    expect(sanitizeAgentId("-alice")).toBeNull();
    expect(sanitizeAgentId("_alice")).toBeNull();
  });
});
