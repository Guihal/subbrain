import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { MemoryDB } from "@subbrain/core/db";

const TEST_DB = "data/test.db";

let db: MemoryDB;
const ctxId = randomUUID();
const arcId = randomUUID();
const reqId = randomUUID();
const sessId = randomUUID();
const sharedId = randomUUID();
const amId = randomUUID();

beforeAll(() => {
  try {
    unlinkSync(TEST_DB);
  } catch {}
  db = new MemoryDB(TEST_DB);
});

afterAll(() => {
  db.close();
  try {
    unlinkSync(TEST_DB);
  } catch {}
});

describe("MemoryDB", () => {
  test("Layer 1 (Focus): get/set/upsert/getAll", () => {
    db.setFocus("identity", "I am the TeamLead agent");
    db.setFocus("directive", "Help the user build software");
    expect(db.getFocus("identity")).toBe("I am the TeamLead agent");
    db.setFocus("identity", "Updated identity");
    expect(db.getFocus("identity")).toBe("Updated identity");
    expect(Object.keys(db.getAllFocus()).length).toBe(2);
  });

  test("Layer 2 (Context): insert/get/update", () => {
    db.insertContext(
      ctxId,
      "Project Alpha",
      "Building the subbrain proxy server",
      "typescript,bun",
    );
    expect(db.getContext(ctxId)?.title).toBe("Project Alpha");
    db.updateContext(ctxId, { title: "Project Alpha v2" });
    expect(db.getContext(ctxId)?.title).toBe("Project Alpha v2");
  });

  test("Layer 3 (Archive): insert/get + source_request_ids round-trip", () => {
    // M-12 (mig 15): confidence unified to REAL [0..1] | null.
    db.insertArchive(
      arcId,
      "Pattern: Error Handling",
      "Use ProviderError for upstream",
      "patterns",
      ["req-1", "req-2"],
      0.9,
      "coder",
    );
    const arc = db.getArchive(arcId);
    expect(arc?.confidence).toBe(0.9);
    expect(JSON.parse(arc?.source_request_ids).length).toBe(2);
  });

  test("Layer 4 (Log): appendLog + getByRequest", () => {
    const logId = db.appendLog(reqId, sessId, "flash", "user", "What is 2+2?", 5);
    expect(logId).toBeGreaterThan(0);
    const logs = db.getLogsByRequest(reqId);
    expect(logs.length).toBe(1);
    expect(logs[0].content).toBe("What is 2+2?");
  });

  test("Shared Memory: insert + getByCategory", () => {
    db.insertShared(
      sharedId,
      "user_facts",
      "User prefers TypeScript over JavaScript",
      "preferences",
    );
    expect(db.getSharedByCategory("user_facts").length).toBe(1);
  });

  test("Agent Memory: insert + getAgentMemories", () => {
    db.insertAgentMemory(amId, "coder", "Bun's built-in SQLite is fast", "bun,sqlite");
    expect(db.getAgentMemories("coder").length).toBe(1);
  });

  test("FTS5 search across context/archive/shared", () => {
    expect(db.searchContext("proxy server").length).toBeGreaterThanOrEqual(1);
    expect(db.searchArchive("error handling").length).toBeGreaterThanOrEqual(1);
    expect(db.searchShared("typescript").length).toBeGreaterThanOrEqual(1);
  });

  test("Vector search: all layers + filtered", () => {
    const vec = new Float32Array(2048);
    vec[0] = 1.0;
    vec[1] = 0.5;
    db.upsertEmbedding(ctxId, "context", vec);
    db.upsertEmbedding(arcId, "archive", vec);
    expect(db.searchEmbeddings(vec, 5).length).toBe(2);
    const filtered = db.searchEmbeddings(vec, 5, "context");
    expect(filtered.length).toBe(1);
    expect(filtered[0].layer).toBe("context");
  });

  test("Cleanup: delete entries across layers", () => {
    db.deleteContext(ctxId);
    expect(db.getContext(ctxId)).toBeNull();
    db.deleteArchive(arcId);
    db.deleteShared(sharedId);
    db.deleteAgentMemory(amId);
    db.deleteEmbedding(ctxId);
    db.deleteEmbedding(arcId);
  });
});
