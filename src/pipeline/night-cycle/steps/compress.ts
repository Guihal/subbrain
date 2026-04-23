import type { ModelRouter } from "../../../lib/model-router";
import type { CompressedEntry } from "../types";
import { parseJson } from "../types";
import { NIGHT_MODEL, nightLog as log } from "./shared";

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
  } catch (err) {
    log.warn(`compress: ${(err as Error).message}`);
    return null;
  }
}
