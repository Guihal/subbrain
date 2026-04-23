import type { ModelRouter } from "../../../lib/model-router";
import { stripThinkTags } from "../types";
import { NIGHT_MODEL, nightLog as log } from "./shared";

/**
 * Returns translated text, or `null` on LLM failure / empty response.
 * Never returns the untranslated original on error — that would leak the
 * Russian source (with its PII-ish patterns) into the English archive and
 * break dedup/compress. Empty inputs and already-English text are passed
 * through unchanged.
 */
export async function translate(
  text: string,
  router: ModelRouter,
): Promise<string | null> {
  if (!text.length) return text;
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
    const raw = response.choices[0]?.message?.content || "";
    const cleaned = stripThinkTags(raw);
    return cleaned.length > 0 ? cleaned : null;
  } catch (err) {
    log.warn(`translate: ${(err as Error).message}`);
    return null;
  }
}
