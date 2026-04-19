/**
 * Individual pipeline steps for the night cycle.
 * Each step is a standalone function taking dependencies as parameters.
 */
import type { MemoryDB, LogRow } from "../../db";
import type { ModelRouter } from "../../lib/model-router";
import type { CompressedEntry } from "./types";
import { buildConversationText, parseJson } from "./types";

// ─── Step 1: PII Scrub ────────────────────────────────

export async function scrubPII(
  text: string,
  router: ModelRouter,
): Promise<string> {
  try {
    const response = await router.chat(
      "flash",
      {
        messages: [
          {
            role: "system",
            content: `You are a PII scrubber. Replace all personal identifiable information in the text with placeholders:
- Names → [NAME]
- Email → [EMAIL]
- Phone → [PHONE]
- Address → [ADDRESS]
- Card numbers → [CARD]
- Dates of birth → [DOB]
- Any other PII → [REDACTED]

Return ONLY the scrubbed text, nothing else. Preserve all other content exactly.`,
          },
          { role: "user", content: text },
        ],
        max_tokens: 4096,
        temperature: 0,
      },
      "low",
    );
    return response.choices[0]?.message?.content || text;
  } catch {
    return text;
  }
}

// ─── Step 2: Translate ────────────────────────────────

export async function translate(
  text: string,
  router: ModelRouter,
): Promise<string> {
  const cyrillicRatio = (text.match(/[а-яё]/gi) || []).length / text.length;
  if (cyrillicRatio < 0.1) return text;

  try {
    const response = await router.chat(
      "flash",
      {
        messages: [
          {
            role: "system",
            content:
              "Translate the following text from Russian to English. Preserve all technical terms, code snippets, and structure. Return ONLY the translation.",
          },
          { role: "user", content: text },
        ],
        max_tokens: 4096,
        temperature: 0.1,
      },
      "low",
    );
    return response.choices[0]?.message?.content || text;
  } catch {
    return text;
  }
}

// ─── Step 3: Compress ─────────────────────────────────

export async function compress(
  text: string,
  requestIds: string[],
  router: ModelRouter,
): Promise<CompressedEntry | null> {
  try {
    const response = await router.chat(
      "flash",
      {
        messages: [
          {
            role: "system",
            content: `You are a knowledge compressor. Given a conversation transcript, extract the key knowledge into a structured entry.

Output JSON:
{
  "title": "Short descriptive title (max 80 chars)",
  "content": "Markdown-formatted summary of decisions, insights, and patterns",
  "tags": "comma,separated,tags",
  "skip": false
}

Rules:
- Only extract genuine new knowledge (decisions, insights, patterns, preferences)
- Content should be self-contained and understandable without the original conversation
- Use Markdown with headers for multi-topic entries
- If the conversation is trivial (greetings, simple Q&A), return {"skip": true}`,
          },
          { role: "user", content: text },
        ],
        max_tokens: 2048,
        temperature: 0.2,
      },
      "low",
    );

    const raw = response.choices[0]?.message?.content || "";
    const parsed = parseJson(raw);
    if (!parsed || parsed.skip) return null;

    return {
      title: parsed.title || "Untitled",
      content: parsed.content || "",
      tags: parsed.tags || "",
      sourceRequestIds: requestIds,
      confidence: "HIGH",
    };
  } catch {
    return null;
  }
}

// ─── Step 4: Verify ──────────────────────────────────

export async function verify(
  entry: CompressedEntry,
  originalText: string,
  router: ModelRouter,
): Promise<CompressedEntry> {
  try {
    const response = await router.chat(
      "flash",
      {
        messages: [
          {
            role: "system",
            content: `You are a fact verifier. Compare a compressed summary with the original text to detect inaccuracies.

Output JSON:
{
  "accurate": true/false,
  "issues": ["list of issues if any"]
}

Only flag genuine factual inaccuracies, not stylistic differences.`,
          },
          {
            role: "user",
            content: `## Compressed summary\n${entry.content}\n\n## Original text (excerpt)\n${originalText.substring(0, 3000)}`,
          },
        ],
        max_tokens: 512,
        temperature: 0.1,
      },
      "low",
    );

    const raw = response.choices[0]?.message?.content || "";
    const parsed = parseJson(raw);
    if (parsed && !parsed.accurate) {
      return { ...entry, confidence: "LOW" };
    }
    return entry;
  } catch {
    return { ...entry, confidence: "LOW" };
  }
}

// ─── Step 5: Dedup ───────────────────────────────────

export async function dedup(
  entry: CompressedEntry,
  memory: MemoryDB,
  router: ModelRouter,
): Promise<boolean> {
  try {
    const existing = memory.searchArchive(
      entry.tags.split(",").slice(0, 3).join(" OR "),
      5,
    );

    if (existing.length === 0) return false;

    const existingSummary = existing
      .map((e) => `[${e.id}] ${e.title}: ${e.snippet}`)
      .join("\n");

    const response = await router.chat(
      "flash",
      {
        messages: [
          {
            role: "system",
            content: `You compare a new knowledge entry with existing archive entries.
Output JSON:
{
  "isDuplicate": true/false,
  "duplicateOf": "id of duplicate entry or null",
  "action": "skip" | "merge" | "append"
}

- "skip": new entry is fully contained in existing
- "merge": new entry adds to existing (return the id to merge with)
- "append": new entry is genuinely new`,
          },
          {
            role: "user",
            content: `## New entry\nTitle: ${entry.title}\n${entry.content}\n\n## Existing entries\n${existingSummary}`,
          },
        ],
        max_tokens: 256,
        temperature: 0.1,
      },
      "low",
    );

    const raw = response.choices[0]?.message?.content || "";
    const parsed = parseJson(raw);
    if (!parsed) return false;

    if (parsed.action === "skip") return true;

    if (parsed.action === "merge" && parsed.duplicateOf) {
      memory.updateArchive(parsed.duplicateOf, {
        content: entry.content,
        tags: entry.tags,
      });
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

// ─── Step 6: Anti-patterns ────────────────────────────

export async function extractAntiPatterns(
  logs: LogRow[],
  router: ModelRouter,
): Promise<string | null> {
  if (logs.length < 4) return null;

  const conversationText = buildConversationText(logs).substring(0, 6000);

  try {
    const response = await router.chat(
      "flash",
      {
        messages: [
          {
            role: "system",
            content: `Analyze the day's conversations and identify anti-patterns — recurring mistakes, blockers, and time-wasters.

Output Markdown with:
## Anti-patterns detected
- Pattern name: description + how to avoid next time

If no anti-patterns found, return exactly: "NONE"`,
          },
          { role: "user", content: conversationText },
        ],
        max_tokens: 1024,
        temperature: 0.3,
      },
      "low",
    );

    const content = response.choices[0]?.message?.content || "";
    if (content.trim() === "NONE" || content.length < 20) return null;
    return content;
  } catch {
    return null;
  }
}

// ─── Step 7: Resolve contradictions ───────────────────

export async function resolveContradictions(
  memory: MemoryDB,
  router: ModelRouter,
): Promise<number> {
  const lowConfidence = memory.db
    .query(
      "SELECT id, title, content FROM layer3_archive WHERE confidence = 'LOW' ORDER BY created_at DESC LIMIT 10",
    )
    .all() as { id: string; title: string; content: string }[];

  if (lowConfidence.length === 0) return 0;
  let resolved = 0;

  for (const entry of lowConfidence) {
    try {
      const related = memory.searchArchive(entry.title, 3);
      if (related.length === 0) {
        memory.updateArchive(entry.id, { confidence: "HIGH" });
        resolved++;
        continue;
      }

      const relatedSummary = related
        .map((r) => `${r.title}: ${r.snippet}`)
        .join("\n");

      const response = await router.chat(
        "flash",
        {
          messages: [
            {
              role: "system",
              content: `Compare the flagged entry with related entries. Determine if there's a contradiction.

Output JSON:
{
  "hasContradiction": true/false,
  "resolution": "keep_new" | "keep_old" | "merge",
  "mergedContent": "only if resolution=merge"
}`,
            },
            {
              role: "user",
              content: `## Flagged entry\n${entry.title}: ${entry.content}\n\n## Related entries\n${relatedSummary}`,
            },
          ],
          max_tokens: 512,
          temperature: 0.1,
        },
        "low",
      );

      const raw = response.choices[0]?.message?.content || "";
      const parsed = parseJson(raw);
      if (!parsed) continue;

      if (!parsed.hasContradiction) {
        memory.updateArchive(entry.id, { confidence: "HIGH" });
        resolved++;
      } else if (parsed.resolution === "keep_new") {
        memory.updateArchive(entry.id, { confidence: "HIGH" });
        resolved++;
      } else if (parsed.resolution === "keep_old") {
        memory.deleteArchive(entry.id);
        resolved++;
      } else if (parsed.resolution === "merge" && parsed.mergedContent) {
        memory.updateArchive(entry.id, {
          content: parsed.mergedContent,
          confidence: "HIGH",
        });
        resolved++;
      }
    } catch {
      // Skip this entry
    }
  }

  return resolved;
}
