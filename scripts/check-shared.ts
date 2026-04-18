import { Database } from "bun:sqlite";
const db = new Database("data/subbrain.db", { readonly: true });
const rows = db.query("SELECT * FROM shared_memory").all();
console.log("count:", rows.length);
for (const r of rows as any[]) {
  console.log("---");
  console.log(`id: ${r.id}`);
  console.log(`category: ${r.category}`);
  console.log(`content: ${r.content}`);
  console.log(`tags: ${r.tags}`);
}
db.close();
