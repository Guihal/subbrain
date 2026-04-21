import type { ModelRouter } from "../lib/model-router";
import type { Metrics } from "../lib/metrics";
import type { ChatResponse, Message } from "../providers/types";

// ─── Types ───────────────────────────────────────────────

type TaskCategory = "code" | "architecture" | "review" | "reasoning";

export interface RoomConfig {
  /** Which specialist roles to invoke */
  agents: string[];
  /** Task category (affects weights) */
  category: TaskCategory;
  /** Timeout per specialist in ms */
  timeout?: number;
}

export interface AgentResponse {
  role: string;
  content: string;
  latencyMs: number;
  timedOut: boolean;
}

export interface ArbitrationResult {
  synthesis: string;
  agentResponses: AgentResponse[];
  category: TaskCategory;
}

// ─── Default Weights ─────────────────────────────────────

/** Initial weights: [code, architecture, review, reasoning] */
const DEFAULT_WEIGHTS: Record<string, Record<TaskCategory, number>> = {
  coder: { code: 1.5, architecture: 0.8, review: 1.0, reasoning: 0.7 },
  critic: { code: 0.8, architecture: 1.0, review: 1.5, reasoning: 1.5 },
  generalist: { code: 1.0, architecture: 1.3, review: 1.0, reasoning: 1.0 },
  chaos: { code: 0.5, architecture: 1.4, review: 0.6, reasoning: 1.2 },
};

// ─── Role Prompts ────────────────────────────────────────

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

const SPECIALIST_TIMEOUT = 30_000;

// ─── ArbitrationRoom ─────────────────────────────────────

export class ArbitrationRoom {
  private metrics: Metrics | null = null;

  constructor(private router: ModelRouter) {}

  setMetrics(metrics: Metrics): void {
    this.metrics = metrics;
  }

  /**
   * Run the "Common Room" arbitration protocol:
   * 1. Dispatch to N specialists in parallel
   * 2. Collect responses (with timeout)
   * 3. Synthesize via TeamLead
   */
  async run(
    userMessage: string,
    executiveSummary: string,
    config: RoomConfig,
  ): Promise<ArbitrationResult> {
    const timeout = config.timeout || SPECIALIST_TIMEOUT;

    // ─── 1. Dispatch to specialists in parallel ────────
    // Per-specialist AbortControllers — used to cancel stragglers when the
    // per-specialist timeout fires. `callSpecialist` already wraps errors, so
    // this loop will never reject; `allSettled` guards against any future
    // change where one specialist's rejection shouldn't kill the whole room.
    const controllers = config.agents.map(() => new AbortController());
    const settled = await Promise.allSettled(
      config.agents.map((role, i) =>
        this.callSpecialist(
          role,
          userMessage,
          executiveSummary,
          timeout,
          config.category,
          controllers[i].signal,
        ),
      ),
    );
    const agentResponses: AgentResponse[] = settled.map((s, i) =>
      s.status === "fulfilled"
        ? s.value
        : {
            role: config.agents[i],
            content: "",
            latencyMs: 0,
            timedOut: false,
          },
    );

    // Filter out timed-out empty responses
    const validResponses = agentResponses.filter((r) => r.content.length > 0);

    // If only 1 response came through, skip synthesis
    if (validResponses.length <= 1) {
      return {
        synthesis: validResponses[0]?.content || "No responses received.",
        agentResponses,
        category: config.category,
      };
    }

    // ─── 2. Synthesize via TeamLead ────────────────────
    const synthesisStart = Date.now();
    const synthesis = await this.synthesize(
      userMessage,
      validResponses,
      config.category,
    );
    this.metrics?.record({
      model: "teamlead",
      priority: "critical",
      stage: "main",
      latencyMs: Date.now() - synthesisStart,
      tokensIn: 0,
      tokensOut: 0,
      status: "ok",
    });

    return {
      synthesis,
      agentResponses,
      category: config.category,
    };
  }

  /**
   * Classify whether the request needs arbitration and pick agents.
   * Returns null if single-model is enough.
   */
  classify(userMessage: string): RoomConfig | null {
    const msg = userMessage.toLowerCase();

    // Explicit triggers
    if (
      msg.includes("обсудите") ||
      msg.includes("покажите разные подходы") ||
      msg.includes("что думает команда") ||
      msg.includes("discuss") ||
      msg.includes("compare approaches")
    ) {
      return {
        agents: ["coder", "critic", "generalist", "chaos"],
        category: "architecture",
      };
    }

    // Architecture / design decisions
    if (
      msg.includes("как организовать") ||
      msg.includes("какой подход лучше") ||
      msg.includes("архитектура") ||
      msg.includes("architecture") ||
      msg.match(/\bили\b.*\bили\b/) || // "X или Y или Z"
      msg.match(/\bvs\b/) ||
      msg.includes("плюсы и минусы") ||
      msg.includes("pros and cons")
    ) {
      return {
        agents: ["coder", "critic", "generalist", "chaos"],
        category: "architecture",
      };
    }

    // Code review
    if (
      msg.includes("проверь") ||
      msg.includes("ревью") ||
      msg.includes("review") ||
      msg.includes("найди баги")
    ) {
      return { agents: ["coder", "critic"], category: "review" };
    }

    // Complex reasoning
    if (
      (msg.includes("почему") && msg.includes("не работает")) ||
      msg.includes("сложный баг") ||
      (msg.includes("debug") && msg.length > 200)
    ) {
      return { agents: ["coder", "generalist"], category: "reasoning" };
    }

    return null; // Single-model
  }

  // ─── Internal ──────────────────────────────────────────

  private async callSpecialist(
    role: string,
    userMessage: string,
    executiveSummary: string,
    timeout: number,
    category: TaskCategory,
    signal?: AbortSignal,
  ): Promise<AgentResponse> {
    const systemPrompt = [
      ROLE_PROMPTS[role] || `Ты — ${role}.`,
      `\n\nКатегория запроса: ${category}.`,
      executiveSummary ? `\n## Контекст\n${executiveSummary}` : "",
    ].join("");

    const start = Date.now();

    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const response = await Promise.race([
        this.router.chat(
          role,
          {
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userMessage },
            ],
            max_tokens: 2048,
            temperature: 0.7,
            signal,
          },
          "critical",
        ),
        timeout > 0
          ? new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("timeout")),
                timeout,
              );
            })
          : new Promise<never>(() => {}),
      ]).finally(() => {
        if (timer) clearTimeout(timer);
      });

      const content = response.choices[0]?.message?.content || "";
      const latencyMs = Date.now() - start;

      this.metrics?.record({
        model: role,
        priority: "critical",
        stage: "main",
        latencyMs,
        tokensIn: response.usage?.prompt_tokens || 0,
        tokensOut: response.usage?.completion_tokens || 0,
        status: "ok",
      });

      return { role, content, latencyMs, timedOut: false };
    } catch (err) {
      const latencyMs = Date.now() - start;
      const timedOut = (err as Error).message === "timeout";

      this.metrics?.record({
        model: role,
        priority: "critical",
        stage: "main",
        latencyMs,
        tokensIn: 0,
        tokensOut: 0,
        status: "error",
        errorType: timedOut ? "timeout" : "other",
      });

      return { role, content: "", latencyMs, timedOut };
    }
  }

  private async synthesize(
    userMessage: string,
    responses: AgentResponse[],
    category: TaskCategory,
  ): Promise<string> {
    const agentSections = responses
      .map((r) => {
        const weight = DEFAULT_WEIGHTS[r.role]?.[category] ?? 1.0;
        const roleName =
          r.role === "coder"
            ? "Кодер"
            : r.role === "critic"
              ? "Критик"
              : r.role === "generalist"
                ? "Генералист"
                : "Хаос";
        return `### ${roleName} (${r.role}) — приоритет в "${category}": ${weight}\n\n${r.content}`;
      })
      .join("\n\n---\n\n");

    const majorityThreshold = Math.floor(responses.length / 2) + 1;

    const systemPrompt = `## Твоя роль
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

    const result = await this.router.chat(
      "teamlead",
      {
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        max_tokens: 4096,
        temperature: 0.5,
      },
      "critical",
    );

    return result.choices[0]?.message?.content || "";
  }
}
