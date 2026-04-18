/**
 * Seed script: initializes the Subbrain memory database with
 * Layer 1 (Focus), Shared Memory (user facts), and cleans test junk.
 *
 * Run: bun scripts/seed.ts
 */
import { MemoryDB } from "../src/db";
import { randomUUID } from "crypto";

const db = new MemoryDB("data/subbrain.db");

console.log("🧹 Cleaning test junk from shared_memory...");
const junk = db.db
  .query(
    "SELECT id FROM shared_memory WHERE content LIKE '%integration test%' OR content = 'test entry'",
  )
  .all() as { id: string }[];
for (const row of junk) {
  db.deleteShared(row.id);
  console.log(`  Deleted: ${row.id}`);
}
console.log(`  Removed ${junk.length} test entries.\n`);

// ─── Layer 1: Focus (always in system prompt) ────────────
console.log("📌 Seeding Layer 1: Focus...");

const focusEntries: Record<string, string> = {
  identity: `We are Subbrain — a Digital Team, a cognitive extension infrastructure ("second brain"). We operate as an autonomous AI corporation embedded in VS Code.`,

  prime_directive: `Make Dmitry's and Nika's lives better. Be useful. Help structure his day, remind about deadlines, be the external scaffolding that helps him live his life better. In the future: find income opportunities online, monitor tech articles (TypeScript, Bun, Elysia, Nuxt, Vue, LLM).`,

  user_profile: `Dmitry (Дмитрий), 22 y/o. Has ADHD + ASD. Freelance developer, looking for stable employment due to financial pressure. Tech stack: TypeScript, Bun, Elysia, Nuxt, Vue. Current hanging project: personal portfolio. Girlfriend: Nika (Ника), 20 y/o.`,

  communication: `User communicates in Russian. Respond in the same language as the user. Be direct, concrete, structured — external structure helps with ADHD. Avoid fluff. Use headers and bullet points.`,

  memory_protocol: `You have access to a 4-layer memory system. Layer 1 (Focus): directives, always loaded. Layer 2 (Context): active project notes. Layer 3 (Archive): compressed knowledge in English. Layer 4 (Raw Log): full interaction history. Shared Memory: persistent facts about the user. Use the context given to you.`,

  current_date: new Date().toISOString().slice(0, 10),
};

for (const [key, value] of Object.entries(focusEntries)) {
  db.setFocus(key, value);
  console.log(`  ✅ ${key}`);
}

// ─── Shared Memory (facts about the user) ────────────────
console.log("\n🧠 Seeding Shared Memory...");

const sharedFacts: { category: string; content: string; tags: string }[] = [
  {
    category: "user",
    content:
      "User: Dmitry (Дмитрий), 22 years old. Has ADHD and ASD. These affect executive function — needs external structure, reminders, clear deadlines, and broken-down tasks.",
    tags: "user,profile,adhd,asd",
  },
  {
    category: "user",
    content:
      "Dmitry's girlfriend: Nika (Ника), 20 years old. Part of the household. Team's mission includes improving her quality of life too.",
    tags: "user,family,nika",
  },
  {
    category: "work",
    content:
      "Dmitry works as a freelance developer. Currently seeking more stable employment due to financial pressure ('финансовая дыра'). Primary income: freelance projects.",
    tags: "work,freelance,finance",
  },
  {
    category: "work",
    content:
      "Hanging project: personal portfolio website. Needs to be completed for job search.",
    tags: "work,portfolio,project",
  },
  {
    category: "tech",
    content:
      "Dmitry's tech stack: TypeScript, Bun, Elysia.js, Nuxt, Vue. Interested in LLM/AI infrastructure. Reads Habr.",
    tags: "tech,stack,typescript,bun,elysia,nuxt,vue,llm",
  },
  {
    category: "system",
    content:
      "Future integrations planned: Telegram access (with excluded private chats), internet browsing for article monitoring (Habr), autonomous 'free sailing' mode for finding income opportunities.",
    tags: "system,roadmap,telegram,habr",
  },
  {
    category: "system",
    content:
      "Telegram integration rules: When Telegram access is added, certain private chats will be excluded from indexing (list TBD). Bot should create chat summaries, track hanging projects mentioned in chats, and monitor deadlines.",
    tags: "system,telegram,rules",
  },
  {
    category: "goal",
    content:
      "Global mission: Be useful. Make Dmitry's and Nika's lives better. Structure his day. Remind about deadlines. Be the external cognitive scaffolding for someone with ADHD/ASD. In autonomous mode: search for online income opportunities, monitor relevant tech articles.",
    tags: "goal,mission,directive",
  },
];

for (const fact of sharedFacts) {
  const id = randomUUID();
  db.insertShared(id, fact.category, fact.content, fact.tags, "seed-script");
  console.log(`  ✅ [${fact.category}] ${fact.content.slice(0, 60)}...`);
}

console.log("\n✅ Seed complete!");
console.log(`  Layer 1 Focus: ${Object.keys(focusEntries).length} entries`);
console.log(`  Shared Memory: ${sharedFacts.length} entries`);

db.close();
