import type { ModelRouter } from "../../../lib/model-router";
import type { CompressedEntry } from "../types";
import { parseJson } from "../types";
import { NIGHT_MODEL, nightLog as log } from "./shared";

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
  } catch (err) {
    log.warn(`verify: ${(err as Error).message}`);
    return { ...entry, confidence: "LOW" };
  }
}
