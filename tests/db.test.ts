import { MemoryDB } from "../src/db";
import { randomUUID } from "crypto";
import { unlinkSync } from "fs";

const TEST_DB = "data/test.db";

// Clean up
try {
  unlinkSync(TEST_DB);
} catch {}

const db = new MemoryDB(TEST_DB);

// --- Layer 1: Focus ---
db.setFocus("identity", "I am the TeamLead agent");
db.setFocus("directive", "Help the user build software");
console.assert(
  db.getFocus("identity") === "I am the TeamLead agent",
  "Focus: get/set",
);
db.setFocus("identity", "Updated identity");
console.assert(db.getFocus("identity") === "Updated identity", "Focus: upsert");
const all = db.getAllFocus();
console.assert(Object.keys(all).length === 2, "Focus: getAllFocus");
console.log("✅ Layer 1 (Focus)");

// --- Layer 2: Context ---
const ctxId = randomUUID();
db.insertContext(
  ctxId,
  "Project Alpha",
  "Building the subbrain proxy server",
  "typescript,bun",
);
const ctx = db.getContext(ctxId);
console.assert(ctx?.title === "Project Alpha", "Context: insert/get");
db.updateContext(ctxId, { title: "Project Alpha v2" });
console.assert(
  db.getContext(ctxId)?.title === "Project Alpha v2",
  "Context: update",
);
console.log("✅ Layer 2 (Context)");

// --- Layer 3: Archive ---
const arcId = randomUUID();
db.insertArchive(
  arcId,
  "Pattern: Error Handling",
  "Use ProviderError for upstream",
  "patterns",
  ["req-1", "req-2"],
  "HIGH",
  "coder",
);
const arc = db.getArchive(arcId);
console.assert(arc?.confidence === "HIGH", "Archive: insert/get");
console.assert(
  JSON.parse(arc!.source_request_ids).length === 2,
  "Archive: source_request_ids",
);
console.log("✅ Layer 3 (Archive)");

// --- Layer 4: Log ---
const reqId = randomUUID();
const sessId = randomUUID();
const logId = db.appendLog(reqId, sessId, "flash", "user", "What is 2+2?", 5);
console.assert(logId > 0, "Log: appendLog returns id");
const logs = db.getLogsByRequest(reqId);
console.assert(
  logs.length === 1 && logs[0].content === "What is 2+2?",
  "Log: getByRequest",
);
console.log("✅ Layer 4 (Log)");

// --- Shared Memory ---
const sharedId = randomUUID();
db.insertShared(
  sharedId,
  "user_facts",
  "User prefers TypeScript over JavaScript",
  "preferences",
);
const shared = db.getSharedByCategory("user_facts");
console.assert(shared.length === 1, "Shared: insert/getByCategory");
console.log("✅ Shared Memory");

// --- Agent Memory ---
const amId = randomUUID();
db.insertAgentMemory(
  amId,
  "coder",
  "Bun's built-in SQLite is fast",
  "bun,sqlite",
);
const agentMem = db.getAgentMemories("coder");
console.assert(agentMem.length === 1, "AgentMem: insert/get");
console.log("✅ Agent Memory");

// --- FTS5 Search ---
const ftsCtx = db.searchContext("proxy server");
console.assert(ftsCtx.length >= 1, "FTS: context search");
const ftsArc = db.searchArchive("error handling");
console.assert(ftsArc.length >= 1, "FTS: archive search");
const ftsShared = db.searchShared("typescript");
console.assert(ftsShared.length >= 1, "FTS: shared search");
console.log("✅ FTS5 Search");

// --- Vector Search ---
const vec = new Float32Array(2048);
vec[0] = 1.0;
vec[1] = 0.5;
db.upsertEmbedding(ctxId, "context", vec);
db.upsertEmbedding(arcId, "archive", vec);
const vecResults = db.searchEmbeddings(vec, 5);
console.assert(vecResults.length === 2, "Vec: search all layers");
const vecFiltered = db.searchEmbeddings(vec, 5, "context");
console.assert(
  vecFiltered.length === 1 && vecFiltered[0].layer === "context",
  "Vec: search filtered",
);
console.log("✅ Vector Search");

// --- Cleanup ---
db.deleteContext(ctxId);
console.assert(db.getContext(ctxId) === null, "Context: delete");
db.deleteArchive(arcId);
db.deleteShared(sharedId);
db.deleteAgentMemory(amId);
db.deleteEmbedding(ctxId);
db.deleteEmbedding(arcId);
console.log("✅ Cleanup / Delete");

db.close();
unlinkSync(TEST_DB);
console.log("\n🎉 All DB tests passed!");
