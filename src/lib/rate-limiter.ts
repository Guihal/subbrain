import type { Priority } from "./model-map";

const DEFAULT_MAX_RPM = 40;
const WINDOW_MS = 60_000;

/** Threshold: low-priority tasks wait when queue is above this fraction */
const LOW_THROTTLE = 0.8;
/** Threshold: normal-priority tasks wait when queue is above this fraction */
const NORMAL_THROTTLE = 0.95;

interface QueuedRequest<T> {
  priority: Priority;
  execute: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  enqueuedAt: number;
}

/**
 * Sliding-window rate limiter with priority queue.
 * Configurable max RPM per provider.
 */
export class RateLimiter {
  private timestamps: number[] = [];
  private queue: QueuedRequest<unknown>[] = [];
  private draining = false;
  private maxRpm: number;

  constructor(maxRpm: number = DEFAULT_MAX_RPM) {
    this.maxRpm = maxRpm;
  }

  /** How many requests were made in the current window */
  get currentLoad(): number {
    this.prune();
    return this.timestamps.length;
  }

  get queueLength(): number {
    return this.queue.length;
  }

  get availableSlots(): number {
    return Math.max(0, this.maxRpm - this.currentLoad);
  }

  /** Schedule a request through the rate limiter */
  schedule<T>(priority: Priority, execute: () => Promise<T>): Promise<T> {
    // If we have capacity and can run immediately, do so
    if (this.canRun(priority)) {
      this.record();
      return execute();
    }

    // Otherwise queue it
    return new Promise<T>((resolve, reject) => {
      const item: QueuedRequest<T> = {
        priority,
        execute,
        resolve,
        reject,
        enqueuedAt: Date.now(),
      };
      this.insertSorted(item as QueuedRequest<unknown>);
      this.drain();
    });
  }

  /** Record a 429 from upstream — back off by adding phantom timestamps */
  backoff429(): void {
    const now = Date.now();
    // Fill remaining window to force waiting
    const slotsToFill = this.maxRpm - this.currentLoad;
    for (let i = 0; i < slotsToFill; i++) {
      this.timestamps.push(now);
    }
  }

  // ─── Internal ──────────────────────────────────────────────

  private prune(): void {
    const cutoff = Date.now() - WINDOW_MS;
    while (this.timestamps.length > 0 && this.timestamps[0] <= cutoff) {
      this.timestamps.shift();
    }
  }

  private record(): void {
    this.timestamps.push(Date.now());
  }

  private canRun(priority: Priority): boolean {
    this.prune();
    const load = this.timestamps.length / this.maxRpm;

    if (this.timestamps.length >= this.maxRpm) return false;
    if (priority === "low" && load >= LOW_THROTTLE) return false;
    if (priority === "normal" && load >= NORMAL_THROTTLE) return false;
    return true; // critical always runs if slots available
  }

  private insertSorted(item: QueuedRequest<unknown>): void {
    const priorityOrder: Record<Priority, number> = {
      critical: 0,
      normal: 1,
      low: 2,
    };
    const idx = this.queue.findIndex(
      (q) => priorityOrder[q.priority] > priorityOrder[item.priority],
    );
    if (idx === -1) {
      this.queue.push(item);
    } else {
      this.queue.splice(idx, 0, item);
    }
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;

    while (this.queue.length > 0) {
      const next = this.queue[0];
      if (!this.canRun(next.priority)) {
        // Wait until a slot opens
        const waitMs = this.msUntilSlot();
        await sleep(waitMs);
        continue;
      }

      this.queue.shift();
      this.record();

      // Fire and don't await — let the promise resolve independently
      next.execute().then(next.resolve, next.reject);
    }

    this.draining = false;
  }

  private msUntilSlot(): number {
    this.prune();
    if (this.timestamps.length === 0) return 0;
    // Wait until the oldest timestamp expires from the window
    const oldest = this.timestamps[0];
    return Math.max(50, oldest + WINDOW_MS - Date.now() + 10);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
