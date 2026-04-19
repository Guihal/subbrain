import type { LLMProvider, ChatParams, ChatResponse } from "../providers/types";
import { ProviderError } from "../providers/nvidia";
import {
  resolveModel,
  getFallback,
  type Priority,
  type ProviderName,
  type ModelTarget,
} from "./model-map";
import { RateLimiter } from "./rate-limiter";

/** Hard timeout for any single provider call (ms) */
const REQUEST_TIMEOUT = 60_000;

/** RPM limits per provider */
const PROVIDER_RPM: Record<ProviderName, number> = {
  nvidia: 40,
  openrouter: 200,
  copilot: 10,
};

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new ProviderError(408, `Request timeout after ${ms}ms: ${label}`),
        ),
      ms,
    );
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

interface Backend {
  provider: LLMProvider;
  limiter: RateLimiter;
}

/**
 * ModelRouter wraps multiple LLMProviders with:
 * - Virtual model → real model resolution (with provider selection)
 * - Per-provider rate limiting (NVIDIA 40 RPM, OpenRouter 200 RPM)
 * - Fallback on 5xx errors (can cross providers)
 * - 429 backoff handling
 */
export class ModelRouter {
  private backends: Record<ProviderName, Backend>;

  constructor(providers: Record<ProviderName, LLMProvider>) {
    this.backends = {} as Record<ProviderName, Backend>;
    for (const [name, provider] of Object.entries(providers)) {
      const pName = name as ProviderName;
      this.backends[pName] = {
        provider,
        limiter: new RateLimiter(PROVIDER_RPM[pName] ?? 40),
      };
    }
  }

  get stats() {
    const nvidia = this.backends.nvidia;
    const or = this.backends.openrouter;
    const copilot = this.backends.copilot;
    return {
      currentLoad: nvidia.limiter.currentLoad,
      queueLength: nvidia.limiter.queueLength,
      availableSlots: nvidia.limiter.availableSlots,
      openrouter: or
        ? {
            currentLoad: or.limiter.currentLoad,
            queueLength: or.limiter.queueLength,
            availableSlots: or.limiter.availableSlots,
          }
        : undefined,
      copilot: copilot
        ? {
            currentLoad: copilot.limiter.currentLoad,
            queueLength: copilot.limiter.queueLength,
            availableSlots: copilot.limiter.availableSlots,
          }
        : undefined,
    };
  }

  /** True when NVIDIA RPM usage > 80% */
  get isOverloaded(): boolean {
    return this.backends.nvidia.limiter.availableSlots < 8;
  }

  /** Direct access to NVIDIA provider for embed/rerank operations */
  get raw(): LLMProvider {
    return this.backends.nvidia.provider;
  }

  private getBackend(provider: ProviderName): Backend {
    return this.backends[provider] ?? this.backends.nvidia;
  }

  /**
   * Non-streaming chat with rate limiting + fallback.
   */
  async chat(
    virtualModel: string,
    params: Omit<ChatParams, "model">,
    priority: Priority = "critical",
  ): Promise<ChatResponse> {
    const primary = resolveModel(virtualModel);
    const fallback = getFallback(virtualModel);
    const backend = this.getBackend(primary.provider);

    return backend.limiter.schedule(priority, async () => {
      try {
        return await withTimeout(
          backend.provider.chat({ ...params, model: primary.model }),
          REQUEST_TIMEOUT,
          primary.model,
        );
      } catch (err) {
        if (err instanceof ProviderError) {
          this.handleProviderError(err, primary.provider);

          // Retry once with same model on 5xx
          if (err.status >= 500) {
            try {
              return await withTimeout(
                backend.provider.chat({ ...params, model: primary.model }),
                REQUEST_TIMEOUT,
                `${primary.model} (retry)`,
              );
            } catch (retryErr) {
              if (fallback && retryErr instanceof ProviderError) {
                return await this.callFallback(fallback, params, priority);
              }
              throw retryErr;
            }
          }

          // On 4xx (except 429/401/403), try fallback
          if (fallback && err.status !== 401 && err.status !== 403) {
            return await this.callFallback(fallback, params, priority);
          }
        }
        throw err;
      }
    });
  }

  /**
   * Call fallback — may be on a different provider with its own rate limiter.
   */
  private async callFallback(
    target: ModelTarget,
    params: Omit<ChatParams, "model">,
    priority: Priority,
  ): Promise<ChatResponse> {
    const fb = this.getBackend(target.provider);
    // If same provider, we're already inside its limiter — call directly
    // If different provider, schedule through its limiter
    const call = () =>
      withTimeout(
        fb.provider.chat({ ...params, model: target.model }),
        REQUEST_TIMEOUT,
        target.model,
      );

    // Always use the fallback backend's limiter
    return fb.limiter.schedule(priority, call);
  }

  /**
   * Streaming chat with rate limiting + fallback.
   */
  chatStream(
    virtualModel: string,
    params: Omit<ChatParams, "model">,
    priority: Priority = "critical",
  ): Promise<ReadableStream<Uint8Array>> {
    const primary = resolveModel(virtualModel);
    const fallback = getFallback(virtualModel);
    const backend = this.getBackend(primary.provider);

    return backend.limiter.schedule(priority, async () => {
      return this.createFallbackStream(primary, fallback, params);
    });
  }

  /**
   * Direct rate-limited call — for embed, rerank, etc.
   * Always uses NVIDIA provider.
   */
  scheduleRaw<T>(priority: Priority, fn: () => Promise<T>): Promise<T> {
    return this.backends.nvidia.limiter.schedule(priority, fn);
  }

  // ─── Internal ──────────────────────────────────────────────

  private handleProviderError(
    err: ProviderError,
    provider: ProviderName,
  ): void {
    if (err.status === 429) {
      this.getBackend(provider).limiter.backoff429();
    }
  }

  private createFallbackStream(
    primary: ModelTarget,
    fallback: ModelTarget | null,
    params: Omit<ChatParams, "model">,
  ): ReadableStream<Uint8Array> {
    const backends = this.backends;
    const handleError = this.handleProviderError.bind(this);

    return new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();

        const tryModel = async (target: ModelTarget): Promise<boolean> => {
          try {
            const backend = backends[target.provider] ?? backends.nvidia;
            const stream = backend.provider.chatStream({
              ...params,
              model: target.model,
            });
            const reader = stream.getReader();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              controller.enqueue(value);
            }
            return true;
          } catch (err) {
            if (err instanceof ProviderError) {
              handleError(err, target.provider);
            }
            return false;
          }
        };

        let ok = false;
        try {
          ok = await tryModel(primary);
          if (!ok && fallback) {
            ok = await tryModel(fallback);
          }

          if (!ok) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ error: { message: "All models failed" } })}\n\n`,
              ),
            );
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ error: { message: msg, type: "router_error" } })}\n\n`,
            ),
          );
        }

        // Only emit DONE if upstream didn't (error cases). Successful streams already include [DONE].
        if (!ok) {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        }
        controller.close();
      },
    });
  }
}
