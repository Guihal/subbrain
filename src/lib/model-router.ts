import type { ProviderError } from "../providers/nvidia";
import type { ChatParams, ChatResponse, LLMProvider } from "../providers/types";
import { getFallback, type Priority, type ProviderName, resolveModel } from "./model-map";
import { type Backend, PROVIDER_RPM } from "./model-router/constants";
import { runChatDispatch } from "./model-router/dispatch";
import { createFallbackStream } from "./model-router/stream";
import { RateLimiter } from "./rate-limiter";

/** Per-provider reserved slot count; drops into direct-mode below this. */
const RESERVED_SLOTS = 8;

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
    };
  }

  /**
   * Per-provider overload check. True when the provider's rate-limiter has
   * fewer than RESERVED_SLOTS free. Returns false when the provider isn't
   * loaded — unreferenced providers can't be overloaded; a chat() call will
   * fail separately via the absent-provider stub.
   */
  isOverloadedFor(provider: ProviderName): boolean {
    const backend = this.backends[provider];
    if (!backend) return false;
    return backend.limiter.availableSlots < RESERVED_SLOTS;
  }

  /**
   * @deprecated Use {@link isOverloadedFor} with a specific provider.
   * Alias preserved for back-compat; only queries the NVIDIA backend,
   * which misleads callers when the actual target is MiniMax/OpenRouter.
   */
  get isOverloaded(): boolean {
    return this.isOverloadedFor("nvidia");
  }

  /** Direct access to NVIDIA provider for embed/rerank operations */
  get raw(): LLMProvider {
    return this.backends.nvidia.provider;
  }

  private getBackend = (provider: ProviderName): Backend => {
    return this.backends[provider] ?? this.backends.nvidia;
  };

  private handleProviderError = (err: ProviderError, provider: ProviderName): void => {
    if (err.status === 429) {
      this.getBackend(provider).limiter.backoff429();
    }
  };

  /** Non-streaming chat with rate limiting + fallback. */
  async chat(
    virtualModel: string,
    params: Omit<ChatParams, "model">,
    priority: Priority = "critical",
  ): Promise<ChatResponse> {
    const primary = resolveModel(virtualModel);
    const fallback = getFallback(virtualModel);
    const backend = this.getBackend(primary.provider);
    return backend.limiter.schedule(priority, () =>
      runChatDispatch(backend, primary, fallback, params, priority, {
        getBackend: this.getBackend,
        handleProviderError: this.handleProviderError,
      }),
    );
  }

  /** Streaming chat with rate limiting + fallback. */
  chatStream(
    virtualModel: string,
    params: Omit<ChatParams, "model">,
    priority: Priority = "critical",
  ): Promise<ReadableStream<Uint8Array>> {
    const primary = resolveModel(virtualModel);
    const fallback = getFallback(virtualModel);
    const backend = this.getBackend(primary.provider);
    return backend.limiter.schedule(priority, async () =>
      createFallbackStream(this.backends, primary, fallback, params, this.handleProviderError),
    );
  }

  /** Direct rate-limited call — for embed, rerank, etc. Always uses NVIDIA. */
  scheduleRaw<T>(priority: Priority, fn: () => Promise<T>): Promise<T> {
    return this.backends.nvidia.limiter.schedule(priority, fn);
  }
}
