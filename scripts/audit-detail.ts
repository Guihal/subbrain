import { Database } from "bun:sqlite";

type ContextRow = {
  id: string;
  title: string;
  tags: string;
  agent_id: string | null;
  content: string;
  created_at: number;
  updated_at: number;
};
type LogRow = { created_at: number; role: string; agent_id: string; content: string };
type TableRow = { name: string };

const db = new Database("data/subbrain.db", { readonly: true });

// Full Layer 2 context entry
const ctx = db.query("SELECT * FROM layer2_context").all() as ContextRow[];
for (const c of ctx) {
  console.log("=== Layer 2 Entry ===");
  console.log("ID:", c.id);
  console.log("Title:", c.title);
  console.log("Tags:", c.tags);
  console.log("Agent:", c.agent_id);
  console.log("Content:");
  console.log(c.content);
  console.log("Created:", new Date(c.created_at * 1000).toISOString());
  console.log("Updated:", new Date(c.updated_at * 1000).toISOString());
}

// Recent logs — full content
console.log("\n=== Last 10 log entries ===");
const logs = db
  .query("SELECT * FROM layer4_log ORDER BY created_at DESC LIMIT 10")
  .all() as LogRow[];
for (const l of logs) {
  const ts = new Date(l.created_at * 1000).toISOString().slice(0, 19);
  console.log(`\n--- ${ts} [${l.role}] model=${l.agent_id} ---`);
  console.log(l.content?.slice(0, 300));
}

// Check embeddings table name
const tables = db
  .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
  .all() as TableRow[];
console.log("\n=== All tables ===");
for (const t of tables) console.log(`  ${t.name}`);

db.close();
