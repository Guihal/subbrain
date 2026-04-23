import type { MemoryDB } from "../db";
import { maskSecrets } from "./redact";

// ─── Types ───────────────────────────────────────────────

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  level: LogLevel;
  stage: string;
  message: string;
  requestId?: string;
  sessionId?: string;
  model?: string;
  durationMs?: number;
  tokensIn?: number;
  tokensOut?: number;
  meta?: Record<string, unknown>;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LEVEL_ICON: Record<LogLevel, string> = {
  debug: "🔍",
  info: "📝",
  warn: "⚠️",
  error: "❌",
};

// ─── Logger ──────────────────────────────────────────────

export class Logger {
  private minLevel: LogLevel;
  private memory: MemoryDB | null = null;

  constructor(minLevel: LogLevel = "info") {
    this.minLevel = minLevel;
  }

  setMemory(memory: MemoryDB): void {
    this.memory = memory;
  }

  log(entry: LogEntry): void {
    if (LEVEL_PRIORITY[entry.level] < LEVEL_PRIORITY[this.minLevel]) return;

    // Console output
    const ts = new Date().toISOString().slice(11, 23);
    const icon = LEVEL_ICON[entry.level];
    const reqTag = entry.requestId ? ` [${entry.requestId.slice(0, 8)}]` : "";
    const dur = entry.durationMs !== undefined ? ` ${entry.durationMs}ms` : "";
    const model = entry.model ? ` (${entry.model})` : "";
    const tokens =
      entry.tokensIn || entry.tokensOut
        ? ` [${entry.tokensIn ?? 0}→${entry.tokensOut ?? 0} tok]`
        : "";

    console.log(
      `${ts} ${icon} [${entry.stage}]${reqTag}${model}${dur}${tokens} ${entry.message}`,
    );

    // DB logging — write to Layer 4 for detailed entries
    if (this.memory && entry.level !== "debug") {
      try {
        const content = this.formatForDb(entry);
        this.memory.appendLog(
          entry.requestId || "system",
          entry.sessionId || "system",
          entry.stage,
          `_log_${entry.level}`,
          content,
        );
      } catch {
        // Never let logging break the app
      }
    }
  }

  // Convenience methods
  debug(stage: string, message: string, extra?: Partial<LogEntry>): void {
    this.log({ level: "debug", stage, message, ...extra });
  }

  info(stage: string, message: string, extra?: Partial<LogEntry>): void {
    this.log({ level: "info", stage, message, ...extra });
  }

  warn(stage: string, message: string, extra?: Partial<LogEntry>): void {
    this.log({ level: "warn", stage, message, ...extra });
  }

  error(stage: string, message: string, extra?: Partial<LogEntry>): void {
    this.log({ level: "error", stage, message, ...extra });
  }

  /**
   * Create a child logger with pre-bound request context.
   */
  forRequest(requestId: string, sessionId: string): RequestLogger {
    return new RequestLogger(this, requestId, sessionId);
  }

  /**
   * Create a scoped logger that prefixes every call with `stage`.
   * Nested scopes chain via `.`: `logger.child("copilot").child("stream")`
   * writes stage `copilot.stream`.
   */
  child(stage: string): ScopedLogger {
    return new ScopedLogger(this, stage);
  }

  private formatForDb(entry: LogEntry): string {
    const parts = [`[${entry.level.toUpperCase()}] ${entry.message}`];
    if (entry.model) parts.push(`model=${entry.model}`);
    if (entry.durationMs !== undefined)
      parts.push(`duration=${entry.durationMs}ms`);
    if (entry.tokensIn) parts.push(`tokens_in=${entry.tokensIn}`);
    if (entry.tokensOut) parts.push(`tokens_out=${entry.tokensOut}`);
    if (entry.meta) {
      for (const [k, v] of Object.entries(entry.meta)) {
        let val: string;
        if (typeof v === "string") {
          val = v;
        } else {
          try {
            val = JSON.stringify(v ?? null);
          } catch {
            val = String(v);
          }
        }
        // Truncate long values
        parts.push(`${k}=${val.length > 500 ? val.slice(0, 500) + "…" : val}`);
      }
    }
    // Write-path secret redaction: strip any api_key / Bearer / sk- / ghp_
    // occurrences before the line lands in layer4_log.
    return maskSecrets(parts.join(" | "));
  }
}

// ─── Request-scoped Logger ───────────────────────────────

export class RequestLogger {
  constructor(
    private parent: Logger,
    private requestId: string,
    private sessionId: string,
  ) {}

  debug(stage: string, message: string, extra?: Partial<LogEntry>): void {
    this.parent.log({
      level: "debug",
      stage,
      message,
      requestId: this.requestId,
      sessionId: this.sessionId,
      ...extra,
    });
  }

  info(stage: string, message: string, extra?: Partial<LogEntry>): void {
    this.parent.log({
      level: "info",
      stage,
      message,
      requestId: this.requestId,
      sessionId: this.sessionId,
      ...extra,
    });
  }

  warn(stage: string, message: string, extra?: Partial<LogEntry>): void {
    this.parent.log({
      level: "warn",
      stage,
      message,
      requestId: this.requestId,
      sessionId: this.sessionId,
      ...extra,
    });
  }

  error(stage: string, message: string, extra?: Partial<LogEntry>): void {
    this.parent.log({
      level: "error",
      stage,
      message,
      requestId: this.requestId,
      sessionId: this.sessionId,
      ...extra,
    });
  }
}

// ─── Scoped Logger (stage-prefixed) ──────────────────────

export class ScopedLogger {
  constructor(
    private parent: Logger,
    private stage: string,
  ) {}

  debug(message: string, extra?: Partial<LogEntry>): void {
    this.parent.log({ level: "debug", stage: this.stage, message, ...extra });
  }
  info(message: string, extra?: Partial<LogEntry>): void {
    this.parent.log({ level: "info", stage: this.stage, message, ...extra });
  }
  warn(message: string, extra?: Partial<LogEntry>): void {
    this.parent.log({ level: "warn", stage: this.stage, message, ...extra });
  }
  error(message: string, extra?: Partial<LogEntry>): void {
    this.parent.log({ level: "error", stage: this.stage, message, ...extra });
  }
  child(subStage: string): ScopedLogger {
    return new ScopedLogger(this.parent, `${this.stage}.${subStage}`);
  }
}

// Singleton
export const logger = new Logger(
  (process.env.LOG_LEVEL as LogLevel) || "debug",
);
