/**
 * Prompt builders for ArbitrationRoom: per-specialist system prompt and
 * teamlead synthesis system prompt. Pure string composition.
 */

import type { AgentResponse } from "./types";
import {
  DEFAULT_WEIGHTS,
  getWeight,
  roleDisplayName,
  type TaskCategory,
} from "./weights";

const ROLE_PROMPTS: Record<string, string> = {
  coder:
    "Ты — senior-инженер (Кодер). Фокус: практичная имплементация, качество кода, паттерны, производительность. Пиши конкретный код когда уместно. По делу.",
  critic:
    "Ты — код-ревьюер и security-аналитик (Критик). Фокус: edge-cases, уязвимости, race conditions, обработка ошибок, скрытые баги. Оспаривай допущения.",
  generalist:
    "Ты — senior tech-lead (Генералист). Фокус: архитектурный баланс, трейд-оффы, поддерживаемость, долгосрочные последствия. Рассматривай альтернативы.",
  chaos:
    "Ты — Хаос, провокатор-стратег (Mistral). Найди 1-2 неочевидные или контринтуитивные позиции: black swan, uncomfortable alternatives, hidden second-order effects. Технически обоснованно. Предположи что «очевидный» ответ ошибочен — что тогда?",
};

export function buildSpecialistSystemPrompt(
  role: string,
  category: TaskCategory,
  executiveSummary: string,
): string {
  return [
    ROLE_PROMPTS[role] || `Ты — ${role}.`,
    `\n\nКатегория запроса: ${category}.`,
    executiveSummary ? `\n## Контекст\n${executiveSummary}` : "",
  ].join("");
}

export function buildSynthesisSystemPrompt(
  responses: AgentResponse[],
  category: TaskCategory,
): string {
  const agentSections = responses
    .map((r) => {
      const weight = getWeight(r.role, category);
      const roleName = roleDisplayName(r.role);
      return `### ${roleName} (${r.role}) — приоритет в "${category}": ${weight}\n\n${r.content}`;
    })
    .join("\n\n---\n\n");

  const majorityThreshold = Math.floor(responses.length / 2) + 1;

  return `## Твоя роль
Ты Тимлид. Ты получил ${responses.length} ответа(-ов) от специалистов и должен вернуть ОДИН итоговый ответ пользователю на русском языке.

## Ответы специалистов

${agentSections}

## Как синтезировать

1. **Выделить консенсус.** Позиция, которую разделяют ≥${majorityThreshold} из ${responses.length} специалистов — базис ответа.
2. **Проверить расхождения.** Причина несогласия — разная интерпретация запроса или разные трейд-оффы?
3. **Принять решение:**
   - Есть консенсус И разногласие не касается безопасности/необратимости → **дай один ответ** (базис + твоя поправка).
   - Нет консенсуса ИЛИ разногласие по безопасности/необратимости → **покажи оба варианта** с условием «если X — выбирай A, иначе B».
   - Особый случай N=2: при любом расхождении — оба варианта (малая выборка).
4. **Веса мнений в категории "${category}"**: Кодер ${DEFAULT_WEIGHTS.coder?.[category] ?? 1.0}, Критик ${DEFAULT_WEIGHTS.critic?.[category] ?? 1.0}, Генералист ${DEFAULT_WEIGHTS.generalist?.[category] ?? 1.0}, Хаос ${DEFAULT_WEIGHTS.chaos?.[category] ?? 1.0}. Вес определяет значимость при разногласиях — не игнорирование. Мнения всех читаются. В ответе пользователю веса не упоминай.
5. **Формат**: как будто ты один отвечал; без «Кодер сказал…». Русский.

## Пример

Вход: «REST или gRPC?», category="architecture".
Ответы: Кодер→REST, Критик→gRPC, Генералист→REST, Хаос→gRPC. Консенсус 2/4 vs 2/4 — нет majority ≥3.
Синтез: «Если команда маленькая и нужна быстрая интеграция — REST. Если производительность и строгая типизация критичны — gRPC. Рекомендую REST со стартом, миграция на gRPC через gRPC-gateway возможна.»`;
}
