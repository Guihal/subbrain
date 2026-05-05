import type { Metrics } from "@subbrain/core/lib/metrics";
import type { ModelRouter } from "@subbrain/core/lib/model-router";
import { buildSpecialistSystemPrompt } from "./prompts";
import type { TaskCategory } from "./weights";

export interface ParticipantInput {
  userMessage: string;
  executiveSummary: string;
  category: TaskCategory;
  signal?: AbortSignal;
  timeoutMs: number;
}

export interface ParticipantOutput {
  id: string;
  content: string;
  latencyMs: number;
  timedOut: boolean;
  confidence?: number;
  artifacts?: unknown[];
}

export interface RoomParticipant {
  id: string;
  kind: "local" | "remote";
  capabilities: string[];
  ask(input: ParticipantInput): Promise<ParticipantOutput>;
}

interface LocalParticipantDeps {
  router: ModelRouter;
  metrics: Metrics | null;
}

export class LocalParticipant implements RoomParticipant {
  kind: "local" = "local";
  capabilities: string[] = [];

  constructor(
    public id: string,
    private deps: LocalParticipantDeps,
  ) {}

  async ask(input: ParticipantInput): Promise<ParticipantOutput> {
    const systemPrompt = buildSpecialistSystemPrompt(
      this.id,
      input.category,
      input.executiveSummary,
    );
    const start = Date.now();
    const controller = new AbortController();
    if (input.signal) {
      if (input.signal.aborted) controller.abort();
      else input.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }

    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const response = await Promise.race([
        this.deps.router.chat(
          this.id,
          {
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: input.userMessage },
            ],
            max_tokens: 2048,
            temperature: 0.7,
            signal: controller.signal,
          },
          "critical",
        ),
        input.timeoutMs > 0
          ? new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                controller.abort();
                reject(new Error("timeout"));
              }, input.timeoutMs);
            })
          : new Promise<never>(() => {}),
      ]).finally(() => {
        if (timer) clearTimeout(timer);
      });

      const content = response.choices[0]?.message?.content || "";
      const latencyMs = Date.now() - start;
      this.deps.metrics?.record({
        model: this.id,
        priority: "critical",
        stage: "main",
        latencyMs,
        tokensIn: response.usage?.prompt_tokens || 0,
        tokensOut: response.usage?.completion_tokens || 0,
        status: "ok",
      });
      return { id: this.id, content, latencyMs, timedOut: false };
    } catch (err) {
      const latencyMs = Date.now() - start;
      const timedOut = (err as Error).message === "timeout";
      this.deps.metrics?.record({
        model: this.id,
        priority: "critical",
        stage: "main",
        latencyMs,
        tokensIn: 0,
        tokensOut: 0,
        status: "error",
        errorType: timedOut ? "timeout" : "other",
      });
      return { id: this.id, content: "", latencyMs, timedOut };
    }
  }
}
