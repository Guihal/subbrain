import type { LogRow } from "../../../db";
import type { ModelRouter } from "../../../lib/model-router";
import { buildConversationText, stripThinkTags } from "../types";
import { nightLog as log, NIGHT_MODEL } from "./shared";

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

    const content = stripThinkTags(response.choices[0]?.message?.content || "");
    if (content === "NONE" || content.length < 20) return null;
    return content;
  } catch (err) {
    log.warn(`extractAntiPatterns: ${(err as Error).message}`);
    return null;
  }
}
