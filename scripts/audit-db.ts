import { Database } from "bun:sqlite";

type FocusRow = { key: string; value: string };
type ContextRow = { agent_id: string | null; title: string; tags: string };
type ArchiveRow = { agent_id: string | null; title: string };
type LogCount = { cnt: number };
type LogRow = { created_at: number; role: string; agent_id: string; content: string };
type SharedRow = { category: string; content: string; tags: string };
type AgentRow = { agent_id: string; content: string };

const db = new Database("data/subbrain.db", { readonly: true });

console.log("=== FULL DATABASE AUDIT ===\n");

// Layer 1: Focus
const focus = db.query("SELECT * FROM layer1_focus").all() as FocusRow[];
console.log(`[Layer 1: Focus] ${focus.length} entries`);
for (const f of focus) console.log(`  - ${f.key}: ${f.value?.slice(0, 100)}`);

// Layer 2: Context
const ctx = db.query("SELECT * FROM layer2_context ORDER BY updated_at DESC").all() as ContextRow[];
console.log(`\n[Layer 2: Context] ${ctx.length} entries`);
for (const c of ctx)
  console.log(`  - [${c.agent_id || "none"}] ${c.title?.slice(0, 80)} (tags: ${c.tags})`);

// Layer 3: Archive
const arch = db
  .query("SELECT * FROM layer3_archive ORDER BY updated_at DESC")
  .all() as ArchiveRow[];
console.log(`\n[Layer 3: Archive] ${arch.length} entries`);
for (const a of arch) console.log(`  - [${a.agent_id || "none"}] ${a.title?.slice(0, 80)}`);

// Layer 4: Raw logs
const logs = db.query("SELECT count(*) as cnt FROM layer4_log").get() as LogCount;
const recentLogs = db
  .query("SELECT * FROM layer4_log ORDER BY created_at DESC LIMIT 5")
  .all() as LogRow[];
console.log(`\n[Layer 4: Raw Logs] ${logs.cnt} total entries`);
for (const l of recentLogs) {
  const ts = new Date(l.created_at * 1000).toISOString().slice(0, 16);
  console.log(`  - ${ts} [${l.role}] model=${l.agent_id} ${l.content?.slice(0, 80)}`);
}

// Shared Memory
const shared = db.query("SELECT * FROM shared_memory").all() as SharedRow[];
console.log(`\n[Shared Memory] ${shared.length} entries`);
for (const s of shared)
  console.log(`  - [${s.category}] ${s.content?.slice(0, 100)} (tags: ${s.tags})`);

// Agent Memory
const agent = db.query("SELECT * FROM agent_memory").all() as AgentRow[];
console.log(`\n[Agent Memory] ${agent.length} entries`);
for (const a of agent) console.log(`  - agent=${a.agent_id}: ${a.content?.slice(0, 80)}`);

// Embeddings
try {
  const embeds = db.query("SELECT count(*) as cnt FROM embeddings").get() as LogCount;
  console.log(`\n[Embeddings] ${embeds.cnt} vectors`);
} catch (e) {
  console.log(`\n[Embeddings] Error: ${e}`);
}

// FTS indices check
try {
  const ftsCtx = db.query("SELECT count(*) as cnt FROM fts_context").get() as LogCount;
  const ftsArch = db.query("SELECT count(*) as cnt FROM fts_archive").get() as LogCount;
  const ftsShared = db.query("SELECT count(*) as cnt FROM fts_shared").get() as LogCount;
  console.log(`\n[FTS] context=${ftsCtx.cnt}, archive=${ftsArch.cnt}, shared=${ftsShared.cnt}`);
} catch (e) {
  console.log(`\n[FTS] Error: ${e}`);
}

console.log("\n=== END AUDIT ===");
db.close();
