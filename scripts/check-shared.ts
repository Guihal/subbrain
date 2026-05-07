import { Database } from "bun:sqlite";

type SharedRow = { id: string; category: string; content: string; tags: string };

const db = new Database("data/subbrain.db", { readonly: true });
const rows = db.query("SELECT * FROM shared_memory").all() as SharedRow[];
console.log("count:", rows.length);
for (const r of rows) {
  console.log("---");
  console.log(`id: ${r.id}`);
  console.log(`category: ${r.category}`);
  console.log(`content: ${r.content}`);
  console.log(`tags: ${r.tags}`);
}
db.close();
