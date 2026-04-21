/**
 * Context compression: when a conversation (agent loop or chat history) grows
 * past SOFT_LIMIT tokens, collapse the middle section into a single summary
 * system message and persist extracted facts to shared_memory so they survive
 * future compressions.
 *
 * Invariants preserved:
 *   - Leading system messages + first user task are kept verbatim.
 *   - The last KEEP_RECENT_MESSAGES are kept verbatim, with boundary snapping
 *     so we never start the tail on a `tool` message or an `assistant` with
 *     dangling `tool_calls` (Copilot/NVIDIA reject both).
 *   - `messages` identity is preserved (same array mutated in place) so callers
 *     holding references don't desync.
 */
import { randomUUID } from "crypto";
import type { Message } from "../providers/types";
import type { ModelRouter } from "../lib/model-router";
import type { MemoryDB } from "../db";
import { logger } from "../lib/logger";
import { estimateTokens } from "./agent-loop/types";

export const SOFT_LIMIT = 80_000;
const KEEP_RECENT_MESSAGES = 10;
// cap input to compressor context window (env COMPRESSOR_MAX_INPUT_CHARS)
const MAX_INPUT_CHARS = Number(process.env.COMPRESSOR_MAX_INPUT_CHARS) || 200_000;
const COMPRESSOR_MODEL = process.env.COMPRESSOR_MODEL || "flash";

const VALID_FACT_CATEGORIES = new Set([
  "user",
  "project",
  "finding",
  "url",
  "decision",
  "preference",
  "other",
]);

const COMPRESSION_PROMPT = `Ты сжимаешь длинную историю агента/чата в компактную выжимку для следующего хода основной модели.

Вход: срез переписки (assistant ↔ tools ↔ user). Выход: JSON с двумя полями:

**summary** (300-500 слов, русский) — плотная сводка: принятые решения, фактические находки (результаты web_navigate/search, числа, URL), открытые ветки, незакрытые ошибки. Пропусти приветствия, мета-обсуждения, budget-логи, шум tool-calls.

**facts** (≤12 записей, больше обычно шум) — факты для долгосрочной памяти. Добавляй ТОЛЬКО те, что пригодятся в **следующей** сессии (не в текущей — для неё есть summary). Для каждого:
- \`category\`: одно из \`user\`, \`project\`, \`finding\`, \`url\`, \`decision\`, \`preference\`. Если ничего не подходит — \`other\`.
- \`content\`: строка в 1-2 предложения, самодостаточное (читается без этой переписки). Только текст, не числа и не объекты.

Формат ответа — строгий JSON. Допускается обёртка в \`\`\`json fenced block (парсер толерантен). Схема:
\`\`\`json
{ "summary": "<текст>", "facts": [{"category": "<enum>", "content": "<текст>"}, ...] }
\`\`\`

Если ничего значимого: \`{"summary": "(ничего значимого)", "facts": []}\`.`;

export function shouldCompress(
  messages: Message[],
  limit: number = SOFT_LIMIT,
): boolean {
  return estimateTokens(messages) > limit;
}

/**
 * Compress `messages` in-place. Returns true if compression happened.
 *
 * On any failure (compressor error, malformed JSON, no middle section) the function
 * logs a warning and returns false — messages untouched. Callers must handle
 * the "still too big" case themselves (usually by letting the next model call
 * fail with a clear error rather than silently truncating).
 */
export async function compressContext(
  messages: Message[],
  router: ModelRouter,
  memory: MemoryDB | null,
  opts?: { keepRecent?: number; limit?: number },
): Promise<boolean> {
  const keepRecent = opts?.keepRecent ?? KEEP_RECENT_MESSAGES;
  const limit = opts?.limit ?? SOFT_LIMIT;

  const before = estimateTokens(messages);
  if (before <= limit) return false;

  // ── Split: head (system + first user) | middle | tail ──
  // Head: all leading system messages, plus the first non-system message
  // (the original task). This preserves "who you are" + "what you were asked".
  let headEnd = 0;
  while (headEnd < messages.length && messages[headEnd].role === "system") {
    headEnd++;
  }
  if (headEnd < messages.length) headEnd++; // include first non-system

  // Tail starts at length - keepRecent, but snap forward to avoid orphan
  // tool messages or assistant-with-tool_calls whose tool result got sliced.
  let tailStart = Math.max(headEnd, messages.length - keepRecent);
  while (tailStart < messages.length) {
    const m = messages[tailStart];
    const isOrphanTool = m.role === "tool";
    const hasToolCalls =
      m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0;
    if (!isOrphanTool && !hasToolCalls) break;
    tailStart++;
  }
  if (tailStart >= messages.length) {
    // Whole tail got snapped away — fall back to keeping just the last user msg
    tailStart = messages.length;
    for (let i = messages.length - 1; i >= headEnd; i--) {
      if (messages[i].role === "user") {
        tailStart = i;
        break;
      }
    }
  }

  const middle = messages.slice(headEnd, tailStart);
  if (middle.length === 0) {
    logger.warn(
      "compressor",
      `Skipped: no middle section (head=${headEnd}, tail=${tailStart}, len=${messages.length})`,
    );
    return false;
  }

  logger.info(
    "compressor",
    `Compressing ${middle.length} messages (~${estimateTokens(middle)} tokens), keeping head=${headEnd} tail=${messages.length - tailStart}`,
  );

  // ── Serialize middle for compressor ──
  const conversationText = middle
    .map((m) => {
      if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
        const calls = m.tool_calls
          .map(
            (tc) => `  → ${tc.function.name}(${tc.function.arguments.slice(0, 500)})`,
          )
          .join("\n");
        return `[assistant]${m.content ? " " + m.content : ""}\n${calls}`;
      }
      if (m.role === "tool") {
        return `[tool ${m.tool_call_id ?? ""}]: ${(m.content ?? "").slice(0, 2000)}`;
      }
      return `[${m.role}]: ${m.content ?? ""}`;
    })
    .join("\n\n")
    .slice(0, MAX_INPUT_CHARS);

  // ── Ask compressor ──
  let summary = "";
  let facts: Array<{ category?: string; content?: string }> = [];
  try {
    const resp = await router.chat(
      COMPRESSOR_MODEL,
      {
        messages: [
          { role: "system", content: COMPRESSION_PROMPT },
          { role: "user", content: conversationText },
        ],
        max_tokens: 4096,
        temperature: 0.2,
      },
      "normal",
    );
    const raw = resp.choices[0]?.message?.content || "";
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        summary = typeof parsed.summary === "string" ? parsed.summary : "";
        facts = Array.isArray(parsed.facts) ? parsed.facts : [];
      } catch {
        summary = raw;
      }
    } else {
      summary = raw;
    }
  } catch (err) {
    logger.warn(
      "compressor",
      `${COMPRESSOR_MODEL} call failed, keeping original: ${(err as Error).message}`,
    );
    return false;
  }

  if (!summary || summary.trim() === "(ничего значимого)" || summary.trim() === "(nothing notable)") {
    logger.warn(
      "compressor",
      `${COMPRESSOR_MODEL} returned no usable summary — keeping original`,
    );
    return false;
  }

  // ── Normalize facts: coerce content to string, map unknown categories to `other`.
  const normalizedFacts: Array<{ category: string; content: string }> = [];
  let droppedCount = 0;
  for (const f of facts) {
    const rawContent = (f as { content?: unknown })?.content;
    const content =
      typeof rawContent === "string"
        ? rawContent.trim()
        : String(rawContent ?? "").trim();
    if (!content) {
      droppedCount += 1;
      continue;
    }
    const rawCat = (f as { category?: unknown })?.category;
    const catStr = typeof rawCat === "string" ? rawCat : "other";
    const category = VALID_FACT_CATEGORIES.has(catStr) ? catStr : "other";
    normalizedFacts.push({ category, content });
  }
  if (droppedCount > 0) {
    logger.warn(
      "compressor",
      `Dropped ${droppedCount} facts with empty content`,
    );
  }
  // ── Persist facts (best-effort) ──
  if (memory && normalizedFacts.length > 0) {
    let written = 0;
    for (const f of normalizedFacts) {
      const category = f.category.slice(0, 64);
      const content = f.content;
      try {
        memory.insertShared(
          randomUUID(),
          category,
          content,
          "",
          "context-compression",
        );
        written++;
      } catch (err) {
        logger.debug(
          "compressor",
          `insertShared failed for "${content.slice(0, 40)}...": ${(err as Error).message}`,
        );
      }
    }
    logger.info(
      "compressor",
      `Persisted ${written}/${normalizedFacts.length} facts to shared_memory`,
    );
  }

  // ── Mutate messages in place: head + summary + tail ──
  const summaryMsg: Message = {
    role: "system",
    content: `[Сжатие ${middle.length} сообщений]: ${summary}`,
  };
  const newMessages = [
    ...messages.slice(0, headEnd),
    summaryMsg,
    ...messages.slice(tailStart),
  ];
  messages.length = 0;
  messages.push(...newMessages);

  const after = estimateTokens(messages);
  logger.info(
    "compressor",
    `Compression done: ${before} → ${after} tokens (saved ${before - after})`,
  );
  return true;
}
