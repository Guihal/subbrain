import type { ModelRouter } from "@subbrain/core/lib/model-router";
import type { EvaluatedLead, FeedItem } from "./types";

const PROMPT = `Оцени задачу по шкале 1-10, насколько быстро пара "разработчик + Claude Code" её закроет.
10 = час работы. 1 = невозможно / риски / домен, где Claude не силён.
Верни СТРОГО JSON без обёртки: {"score": <int 1-10>, "reason": "<одна короткая строка почему>"}.`;

export async function evaluateLead(
  router: ModelRouter,
  item: FeedItem,
  signal: AbortSignal,
): Promise<EvaluatedLead> {
  const user = [
    `Биржа: ${item.source}`,
    `Заголовок: ${item.title}`,
    `Бюджет: ${item.budget ?? "?"} RUB`,
    `Дедлайн (дней): ${item.deadlineDays ?? "?"}`,
    item.description ? `Описание: ${item.description}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  // coder = MiniMax (devstral fallback), fast + reliable JSON. flash = reasoning model,
  // slower, sometimes garbled. Try the cheap one first; fall back on
  // parse-fail only.
  const first = await safeEvaluate(router, "coder", user, signal);
  if (first) return first;
  if (signal.aborted) return { score: 0, reason: "evaluate_aborted" };
  const second = await safeEvaluate(router, "flash", user, signal);
  return second ?? { score: 0, reason: "evaluate_parse_failed" };
}

async function safeEvaluate(
  router: ModelRouter,
  role: string,
  user: string,
  signal: AbortSignal,
): Promise<EvaluatedLead | null> {
  try {
    return await tryEvaluate(router, role, user, signal);
  } catch {
    return null;
  }
}

async function tryEvaluate(
  router: ModelRouter,
  role: string,
  user: string,
  signal: AbortSignal,
): Promise<EvaluatedLead | null> {
  if (signal.aborted) return null;
  const resp = await router.chat(
    role,
    {
      messages: [
        { role: "system", content: PROMPT },
        { role: "user", content: user },
      ],
      temperature: 0.2,
      max_tokens: 200,
      signal,
    },
    "low",
  );
  const content = resp.choices[0]?.message?.content ?? "";
  return parseJson(content);
}

function parseJson(text: string): EvaluatedLead | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(text.slice(start, end + 1)) as Partial<EvaluatedLead>;
    const score = Number(obj.score);
    if (!Number.isFinite(score) || score < 1 || score > 10) return null;
    return { score: Math.round(score), reason: String(obj.reason ?? "") };
  } catch {
    return null;
  }
}
