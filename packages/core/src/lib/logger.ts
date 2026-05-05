import type { MemoryDB } from "../db/index";
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

const LEVEL_PRIORITY: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const LEVEL_ICON: Record<LogLevel, string> = { debug: "🔍", info: "📝", warn: "⚠️", error: "❌" };

// OBS-1: track which roles have already tripped the layer4_log CHECK so we
// surface silent drops on first occurrence without spamming logs. Module-level
// Set: process-lifetime memory, never serialized. Export for tests only —
// do not mutate from other modules.
export const _warnedRejectedRoles = new Set<string>();
let _inLoggerCatch = false;

// ─── Logger ──────────────────────────────────────────────

export class Logger {
  private memory: MemoryDB | null = null;

  constructor(private minLevel: LogLevel = "info") {}

  setMemory(memory: MemoryDB): void {
    this.memory = memory;
  }

  log(entry: LogEntry): void {
    if (LEVEL_PRIORITY[entry.level] < LEVEL_PRIORITY[this.minLevel]) return;

    const _ts = new Date().toISOString().slice(11, 23);
    const _icon = LEVEL_ICON[entry.level];
    const _reqTag = entry.requestId ? ` [${entry.requestId.slice(0, 8)}]` : "";
    const _dur = entry.durationMs === undefined ? "" : ` ${entry.durationMs}ms`;
    const _model = entry.model ? ` (${entry.model})` : "";
    const _tokens =
      entry.tokensIn || entry.tokensOut
        ? ` [${entry.tokensIn ?? 0}→${entry.tokensOut ?? 0} tok]`
        : "";

    const line = `${_ts} ${_icon}${_reqTag} [${entry.stage}] ${entry.message}${_dur}${_model}${_tokens}`;

    // Console fallback when no memory DB attached (tests, early bootstrap).
    if (!this.memory) {
      // biome-ignore lint/suspicious/noConsole: legitimate fallback when memory DB not attached
      console.log(line);
      return;
    }

    // DB logging — write to Layer 4 for detailed entries.
    if (entry.level !== "debug") {
      const role = `_log_${entry.level}`;
      try {
        this.memory.appendLog(
          entry.requestId || "system",
          entry.sessionId || "system",
          entry.stage,
          role,
          this.formatForDb(entry),
        );
      } catch (err) {
        // Never let logging break the app. Surface a CHECK-constraint drop
        // (silent before OBS-1) once per unique role so future role drift is
        // visible. M-3 re-entrancy guard: only console.* is safe in this
        // catch — `logger.warn(...)` would re-enter Logger.log → recurse
        // forever. The boolean gate makes the recursion observable (one
        // console line, then stop) instead of stack-overflowing.
        if (_inLoggerCatch) return;
        _inLoggerCatch = true;
        try {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("CHECK constraint failed") && !_warnedRejectedRoles.has(role)) {
            _warnedRejectedRoles.add(role);
            console.error(
              `[logger] Layer4 role rejected by CHECK constraint: ${role} — entry dropped. Missing schema migration?`,
            );
          }
        } finally {
          _inLoggerCatch = false;
        }
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

  /** Create a child logger with pre-bound request context. */
  forRequest(requestId: string, sessionId: string): RequestLogger {
    return new RequestLogger(this, requestId, sessionId);
  }

  /**
   * Create a scoped logger that prefixes every call with `stage`. Nested
   * scopes chain via `.`: `logger.child("minimax").child("stream")` writes
   * stage `minimax.stream`.
   */
  child(stage: string): ScopedLogger {
    return new ScopedLogger(this, stage);
  }

  private formatForDb(entry: LogEntry): string {
    const parts = [`[${entry.level.toUpperCase()}] ${entry.message}`];
    if (entry.model) parts.push(`model=${entry.model}`);
    if (entry.durationMs !== undefined) parts.push(`duration=${entry.durationMs}ms`);
    if (entry.tokensIn) parts.push(`tokens_in=${entry.tokensIn}`);
    if (entry.tokensOut) parts.push(`tokens_out=${entry.tokensOut}`);
    if (entry.meta) {
      for (const [k, v] of Object.entries(entry.meta)) {
        let val: string;
        if (typeof v === "string") val = v;
        else {
          try {
            val = JSON.stringify(v ?? null);
          } catch {
            val = String(v);
          }
        }
        parts.push(`${k}=${val.length > 500 ? `${val.slice(0, 500)}…` : val}`);
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

  private emit(level: LogLevel, stage: string, message: string, extra?: Partial<LogEntry>): void {
    this.parent.log({
      level,
      stage,
      message,
      requestId: this.requestId,
      sessionId: this.sessionId,
      ...extra,
    });
  }

  debug = (stage: string, message: string, extra?: Partial<LogEntry>) =>
    this.emit("debug", stage, message, extra);
  info = (stage: string, message: string, extra?: Partial<LogEntry>) =>
    this.emit("info", stage, message, extra);
  warn = (stage: string, message: string, extra?: Partial<LogEntry>) =>
    this.emit("warn", stage, message, extra);
  error = (stage: string, message: string, extra?: Partial<LogEntry>) =>
    this.emit("error", stage, message, extra);
}

// ─── Scoped Logger (stage-prefixed) ──────────────────────

export class ScopedLogger {
  constructor(
    private parent: Logger,
    private stage: string,
  ) {}

  private emit(level: LogLevel, message: string, extra?: Partial<LogEntry>): void {
    this.parent.log({ level, stage: this.stage, message, ...extra });
  }

  debug = (message: string, extra?: Partial<LogEntry>) => this.emit("debug", message, extra);
  info = (message: string, extra?: Partial<LogEntry>) => this.emit("info", message, extra);
  warn = (message: string, extra?: Partial<LogEntry>) => this.emit("warn", message, extra);
  error = (message: string, extra?: Partial<LogEntry>) => this.emit("error", message, extra);

  child(subStage: string): ScopedLogger {
    return new ScopedLogger(this.parent, `${this.stage}.${subStage}`);
  }
}

// Singleton
export const logger = new Logger((process.env.LOG_LEVEL as LogLevel) || "debug");
