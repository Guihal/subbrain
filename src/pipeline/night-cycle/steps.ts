/**
 * Individual pipeline steps for the night cycle.
 * Each step is a standalone function taking dependencies as parameters.
 */
import type { MemoryDB, LogRow } from "../../db";
import type { ModelRouter } from "../../lib/model-router";
import type { RAGPipeline } from "../../rag";
import type { CompressedEntry } from "./types";
import { buildConversationText, parseJson } from "./types";

/**
 * Virtual role used for all night-cycle LLM calls. Default is `coder`
 * (devstral-2, NVIDIA, instruct/non-reasoning) — previous `flash`
 * (stepfun-3.5-flash) is a reasoning model that spent ~25s/call on
 * "thinking" even for mechanical tasks like PII scrubbing, stretching
 * a full cycle to 7+ hours. `coder` does the same work in 3–5s/call.
 *
 * Override via NIGHT_CYCLE_MODEL env.
 */
const NIGHT_MODEL = process.env.NIGHT_CYCLE_MODEL || "coder";

// ─── Step 1: PII Scrub ────────────────────────────────

export async function scrubPII(
  text: string,
  router: ModelRouter,
): Promise<string> {
  try {
    const response = await router.chat(
      NIGHT_MODEL,
      {
        messages: [
          {
            role: "system",
            content: `Ты — PII scrubber для личного архива. Архив принадлежит одному пользователю (owner) — это его память. Его персональные данные НЕ PII — это core-контекст.

## Whitelist (НЕ скрабь — это owner/family):
- Имена членов семьи и близких (обычно 2-3 уникальных имени, повторяющихся в архиве).
- Own email/Telegram/GitHub owner'а (тот, кто повторяется в системных сообщениях).
- Технический стек и названия проектов owner'а.

## Scrub (замени на placeholder):
- **Внешние люди** (разовые контакты, клиенты): → [CONTACT_NAME]
- **Внешние email/телефоны** (не owner'а): → [EXT_EMAIL], [EXT_PHONE]
- **Физические адреса** (любые): → [ADDRESS]
- **Платёжные данные**: карта → [CARD], bank account → [ACCOUNT], CVV/PIN → [SECRET]
- **Гос-ID**: паспорт/СНИЛС/ИНН → [GOV_ID]
- **Медицина**: диагнозы/рецепты → [MEDICAL]

## Правила
- Сомневаешься, owner ли это? — оставь. False-positive вреднее false-negative для личного архива.
- НЕ catch-all «любая PII → [REDACTED]».

Верни ТОЛЬКО отредактированный текст.`,
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
      NIGHT_MODEL,
      {
        messages: [
          {
            role: "system",
            content:
              "Переведи текст с русского на английский. Сохрани технические термины, код, структуру. Верни ТОЛЬКО перевод.",
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
      NIGHT_MODEL,
      {
        messages: [
          {
            role: "system",
            content: `Ты — knowledge compressor. Из транскрипта разговора извлеки ключевое знание в структурированную запись.

Вывод JSON:
{
  "title": "Короткий заголовок (≤80 символов)",
  "content": "Markdown-сводка: решения, инсайты, паттерны",
  "tags": "comma,separated,tags",
  "skip": false
}

Правила:
- Только настоящее новое знание (решения, инсайты, паттерны, предпочтения).
- Content самодостаточен — читается без оригинального разговора.
- Markdown с заголовками для multi-topic записей.
- Тривиальный разговор (приветствия, короткие Q&A) → {"skip": true}.`,
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
      NIGHT_MODEL,
      {
        messages: [
          {
            role: "system",
            content: `Ты — fact verifier. Сравни сжатую сводку с оригинальным текстом.

Вывод JSON:
{
  "accurate": true/false,
  "issues": ["список проблем"]
}

Accurate=false → confidence записи понижается до LOW (запись НЕ удаляется). Флагуй ТОЛЬКО:
- Числа/имена/URL в сводке не совпадают с оригиналом.
- Факты в сводке, которых нет в оригинале (галлюцинация).
- Противоречия оригиналу.

НЕ флагуй (accurate=true):
- Стилистические различия.
- Пропуск второстепенного (цель compression).
- Переформулировки с сохранением смысла.`,
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
  rag?: RAGPipeline,
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
      NIGHT_MODEL,
      {
        messages: [
          {
            role: "system",
            content: `Ты сравниваешь новую запись с existing archive entries, которые найдены по пересечению тегов (FTS OR-search по top-3 тегов новой записи).

Вывод JSON:
{
  "isDuplicate": true/false,
  "duplicateOf": "id дубликата или null",
  "action": "skip" | "merge" | "append"
}

Actions:
- **skip**: новая ПОЛНОСТЬЮ перекрывается existing по теме и содержанию. Теги «python,scripting» — новая «Python — скриптовый язык», existing «Python — динамический язык для scripting и ML». Новая ничего не добавляет.
- **merge**: общие теги + новая добавляет детали по той же теме. Теги «nuxt,vue» — новая «Nuxt 3 получил Vapor mode», existing «Nuxt 3 — SSR фреймворк на Vue 3». Верни \`duplicateOf\` = id existing.
- **append**: теги пересекаются, но тема реально другая. Теги «python,ml» — новая «PyTorch лучше TensorFlow для RL», existing «Python как язык программирования».`,
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
      // Re-index: merged content must be searchable by its new vector.
      if (rag) {
        try {
          await rag.indexEntry(parsed.duplicateOf, "archive", entry.content);
        } catch {
          // Skip re-embed on provider error — next night-cycle retries.
        }
      }
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
      NIGHT_MODEL,
      {
        messages: [
          {
            role: "system",
            content: `Проанализируй диалоги дня и найди анти-паттерны — повторяющиеся ошибки, блокеры, time-wasters.

Вывод Markdown:
## Anti-patterns detected
- Имя паттерна: описание + как избежать

Правила:
- Флагай ТОЛЬКО повторяющееся (≥2 раза) или системное.
- Одиночная ошибка в тяжёлой задаче — не pattern.
- Если нет паттернов → верни точно "NONE".
- Если есть — описывай развёрнуто: ответ короче 20 символов (content.trim().length < 20) код интерпретирует как null.`,
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
  rag?: RAGPipeline,
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
        NIGHT_MODEL,
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
        if (rag) {
          try {
            await rag.indexEntry(entry.id, "archive", parsed.mergedContent);
          } catch {
            // Skip re-embed on provider error
          }
        }
        resolved++;
      }
    } catch {
      // Skip this entry
    }
  }

  return resolved;
}
