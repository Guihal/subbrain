import type { ModelRouter } from "../../../lib/model-router";
import { stripThinkTags } from "../types";
import { nightLog as log, NIGHT_MODEL } from "./shared";

/**
 * Returns scrubbed text, or `null` if scrubbing fails / returns empty.
 * Never returns the original unscrubbed text — privacy contract relies on
 * the caller treating `null` as "do not archive" (see PR-3 / C-3 in
 * docs/audits/2026-04-23-global-refactor-plan.md).
 */
export async function scrubPII(text: string, router: ModelRouter): Promise<string | null> {
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
    const raw = response.choices[0]?.message?.content || "";
    const cleaned = stripThinkTags(raw);
    return cleaned.length > 0 ? cleaned : null;
  } catch (err) {
    log.warn(`scrubPII: ${(err as Error).message}`);
    return null;
  }
}
