import { randomUUID } from "crypto";
import type { MemoryDB, LogRow } from "../db";
import type { ModelRouter } from "../lib/model-router";
import type { RAGPipeline } from "../rag";

// ─── Types ───────────────────────────────────────────────

export interface NightCycleResult {
  processedLogs: number;
  sessionsProcessed: number;
  archiveEntriesCreated: number;
  antiPatternsFound: number;
  contradictionsResolved: number;
  errors: string[];
  lastProcessedId: number;
}

interface CompressedEntry {
  title: string;
  content: string;
  tags: string;
  sourceRequestIds: string[];
  confidence: "HIGH" | "LOW";
}

// ─── Constants ───────────────────────────────────────────

const BATCH_SIZE = 500;
const FOCUS_KEY_LAST_PROCESSED = "night_cycle_last_processed_id";

// ─── NightCycle ──────────────────────────────────────────

export class NightCycle {
  constructor(
    private memory: MemoryDB,
    private router: ModelRouter,
    private rag: RAGPipeline,
  ) {}

  /**
   * Run the full night cycle pipeline:
   * 1. PII detection & scrub
   * 2. Translation RU→EN
   * 3. Compression (Layer 4 → Layer 3)
   * 4. Verification
   * 5. Deduplication
   * 6. Anti-patterns
   * 7. Contradiction resolution
   */
  async run(): Promise<NightCycleResult> {
    const result: NightCycleResult = {
      processedLogs: 0,
      sessionsProcessed: 0,
      archiveEntriesCreated: 0,
      antiPatternsFound: 0,
      contradictionsResolved: 0,
      errors: [],
      lastProcessedId: 0,
    };

    // Get last processed position
    const lastIdStr = this.memory.getFocus(FOCUS_KEY_LAST_PROCESSED);
    const lastProcessedId = lastIdStr ? parseInt(lastIdStr, 10) : 0;

    // Fetch unprocessed logs
    const logs = this.memory.getLogsSince(lastProcessedId, BATCH_SIZE);
    if (logs.length === 0) return result;

    result.processedLogs = logs.length;
    result.lastProcessedId = logs[logs.length - 1].id;

    // Group by session
    const sessions = this.memory.groupLogsBySession(logs);
    result.sessionsProcessed = sessions.size;

    // Process each session
    for (const [sessionId, sessionLogs] of sessions) {
      try {
        // Build conversation text from session logs
        const conversationText = this.buildConversationText(sessionLogs);
        if (conversationText.length < 50) continue; // Skip trivial sessions

        // ─── Step 1: PII scrub ─────────────────────────
        const scrubbed = await this.scrubPII(conversationText);

        // ─── Step 2: Translate RU → EN ─────────────────
        const translated = await this.translate(scrubbed);

        // ─── Step 3: Compress → structured entry ───────
        const requestIds = [...new Set(sessionLogs.map((l) => l.request_id))];
        const compressed = await this.compress(translated, requestIds);

        if (!compressed) continue;

        // ─── Step 4: Verify compressed vs original ─────
        const verified = await this.verify(compressed, translated);

        // ─── Step 5: Dedup against existing Layer 3 ────
        const isDuplicate = await this.dedup(verified);
        if (isDuplicate) continue;

        // Write to Layer 3
        const entryId = randomUUID();
        this.memory.insertArchive(
          entryId,
          verified.title,
          verified.content,
          verified.tags,
          verified.sourceRequestIds,
          verified.confidence,
          "night-cycle",
        );
        // Auto-embed
        this.rag
          .indexEntry(entryId, "archive", verified.content)
          .catch(() => {});
        result.archiveEntriesCreated++;
      } catch (err) {
        result.errors.push(`Session ${sessionId}: ${(err as Error).message}`);
      }
    }

    // ─── Step 6: Anti-patterns ─────────────────────────
    try {
      const antiPatterns = await this.extractAntiPatterns(logs);
      if (antiPatterns) {
        const apId = randomUUID();
        this.memory.insertArchive(
          apId,
          "Anti-patterns: " + new Date().toISOString().slice(0, 10),
          antiPatterns,
          "anti-patterns,night-cycle",
          [],
          "HIGH",
          "night-cycle",
        );
        this.rag.indexEntry(apId, "archive", antiPatterns).catch(() => {});
        result.antiPatternsFound = 1;
      }
    } catch (err) {
      result.errors.push(`Anti-patterns: ${(err as Error).message}`);
    }

    // ─── Step 7: Resolve contradictions ────────────────
    try {
      const resolved = await this.resolveContradictions();
      result.contradictionsResolved = resolved;
    } catch (err) {
      result.errors.push(`Resolve: ${(err as Error).message}`);
    }

    // Save progress
    this.memory.setFocus(
      FOCUS_KEY_LAST_PROCESSED,
      String(result.lastProcessedId),
    );

    return result;
  }

  // ─── Step 1: PII Scrub ────────────────────────────────

  private async scrubPII(text: string): Promise<string> {
    // Call gliner-pii model to detect PII entities
    try {
      const response = await this.router.chat(
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
      // If PII scrub fails, continue with original (log but don't block)
      return text;
    }
  }

  // ─── Step 2: Translate ────────────────────────────────

  private async translate(text: string): Promise<string> {
    // Detect if text contains significant Russian content
    const cyrillicRatio = (text.match(/[а-яё]/gi) || []).length / text.length;
    if (cyrillicRatio < 0.1) return text; // Already mostly English

    try {
      const response = await this.router.chat(
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
      return text; // Fallback: keep original
    }
  }

  // ─── Step 3: Compress ─────────────────────────────────

  private async compress(
    text: string,
    requestIds: string[],
  ): Promise<CompressedEntry | null> {
    try {
      const response = await this.router.chat(
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
      const parsed = this.parseJson(raw);
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

  private async verify(
    entry: CompressedEntry,
    originalText: string,
  ): Promise<CompressedEntry> {
    try {
      const response = await this.router.chat(
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
      const parsed = this.parseJson(raw);
      if (parsed && !parsed.accurate) {
        return { ...entry, confidence: "LOW" };
      }
      return entry;
    } catch {
      // Verification failed → mark as LOW confidence
      return { ...entry, confidence: "LOW" };
    }
  }

  // ─── Step 5: Dedup ───────────────────────────────────

  private async dedup(entry: CompressedEntry): Promise<boolean> {
    try {
      // Search existing archives by tags & content similarity
      const existing = this.memory.searchArchive(
        entry.tags.split(",").slice(0, 3).join(" OR "),
        5,
      );

      if (existing.length === 0) return false;

      // Ask flash to compare
      const existingSummary = existing
        .map((e) => `[${e.id}] ${e.title}: ${e.snippet}`)
        .join("\n");

      const response = await this.router.chat(
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
      const parsed = this.parseJson(raw);
      if (!parsed) return false;

      if (parsed.action === "skip") return true;

      if (parsed.action === "merge" && parsed.duplicateOf) {
        // Update existing entry with merged content
        this.memory.updateArchive(parsed.duplicateOf, {
          content: entry.content,
          tags: entry.tags,
        });
        return true; // Don't create new entry
      }

      return false; // append = not duplicate
    } catch {
      return false; // If dedup fails, treat as new
    }
  }

  // ─── Step 6: Anti-patterns ────────────────────────────

  private async extractAntiPatterns(logs: LogRow[]): Promise<string | null> {
    // Only process if there's enough data
    if (logs.length < 4) return null;

    const conversationText = this.buildConversationText(logs).substring(
      0,
      6000,
    );

    try {
      const response = await this.router.chat(
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

  private async resolveContradictions(): Promise<number> {
    // Get recent LOW confidence entries
    const lowConfidence = this.memory.db
      .query(
        "SELECT id, title, content FROM layer3_archive WHERE confidence = 'LOW' ORDER BY created_at DESC LIMIT 10",
      )
      .all() as { id: string; title: string; content: string }[];

    if (lowConfidence.length === 0) return 0;
    let resolved = 0;

    for (const entry of lowConfidence) {
      try {
        // Search for related HIGH confidence entries
        const related = this.memory.searchArchive(entry.title, 3);
        if (related.length === 0) {
          // No contradiction possible — promote to HIGH
          this.memory.updateArchive(entry.id, { confidence: "HIGH" });
          resolved++;
          continue;
        }

        const relatedSummary = related
          .map((r) => `${r.title}: ${r.snippet}`)
          .join("\n");

        const response = await this.router.chat(
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
        const parsed = this.parseJson(raw);
        if (!parsed) continue;

        if (!parsed.hasContradiction) {
          this.memory.updateArchive(entry.id, { confidence: "HIGH" });
          resolved++;
        } else if (parsed.resolution === "keep_new") {
          this.memory.updateArchive(entry.id, { confidence: "HIGH" });
          resolved++;
        } else if (parsed.resolution === "keep_old") {
          this.memory.deleteArchive(entry.id);
          resolved++;
        } else if (parsed.resolution === "merge" && parsed.mergedContent) {
          this.memory.updateArchive(entry.id, {
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

  // ─── Helpers ──────────────────────────────────────────

  private buildConversationText(logs: LogRow[]): string {
    return logs
      .filter((l) => l.role === "user" || l.role === "assistant")
      .map((l) => `${l.role === "user" ? "User" : "Assistant"}: ${l.content}`)
      .join("\n\n");
  }

  private parseJson(text: string): any {
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const raw = jsonMatch ? jsonMatch[1].trim() : text.trim();
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
}
