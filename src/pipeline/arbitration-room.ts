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
    "You are a senior software engineer (Coder). Focus on practical implementation, code quality, design patterns, and performance. Write concrete code when relevant. Be direct.",
  critic:
    "You are a code reviewer and security analyst (Critic). Focus on edge cases, security vulnerabilities, race conditions, error handling, and potential bugs. Challenge assumptions.",
  generalist:
    "You are a senior tech lead (Generalist). Focus on architectural balance, trade-offs between approaches, maintainability, and long-term implications. Consider alternatives.",
  chaos:
    "You are Chaos, a contrarian strategist powered by Mistral. Your job is to deliberately pressure-test the discussion with weird, adversarial, non-obvious, or high-variance ideas. Surface black swans, bizarre edge cases, uncomfortable alternatives, hidden second-order effects, and anti-consensus takes. Be provocative but technically grounded.",
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
    const specialistPromises = config.agents.map((role) =>
      this.callSpecialist(role, userMessage, executiveSummary, timeout),
    );

    const agentResponses = await Promise.all(specialistPromises);

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
  ): Promise<AgentResponse> {
    const systemPrompt = [
      ROLE_PROMPTS[role] || `You are a ${role}.`,
      executiveSummary ? `\n## Context\n${executiveSummary}` : "",
    ].join("");

    const start = Date.now();

    try {
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
          },
          "critical",
        ),
        timeout > 0
          ? new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("timeout")), timeout),
            )
          : new Promise<never>(() => {}),
      ]);

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
            ? "Кодлер"
            : r.role === "critic"
              ? "Критик"
              : r.role === "generalist"
                ? "Генералист"
                : "Хаос";
        return `### ${roleName} (${r.role}) — вес: ${weight}\n\n${r.content}`;
      })
      .join("\n\n---\n\n");

    const systemPrompt = `## Твоя роль

Ты Тимлид. Тебе дали один запрос и ${responses.length} ответа(-ов) от специалистов.
Синтезируй единый ответ.

## Ответы специалистов

${agentSections}

## Инструкции

1. Найди **консенсус** — что все согласны.
2. Отметь **разногласия** — кто с кем не согласен и почему.
3. Прими **решение** с обоснованием.
4. Если разногласие критическое (безопасность, необратимость) — покажи пользователю оба варианта.
5. Формат ответа: как если бы ты один отвечал (не упоминай агентов напрямую).`;

    const result = await this.router.chat(
      "teamlead",
      {
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        max_tokens: 4096,
        temperature: 0.4,
      },
      "critical",
    );

    return result.choices[0]?.message?.content || "";
  }
}
