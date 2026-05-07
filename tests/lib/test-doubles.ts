/**
 * Typed test doubles. Not a `*.test.ts` so `bun test` ignores it.
 *
 * - `noopLog()` — `RequestLogger`-shaped no-op stub for code that takes
 *   `RequestLogger` (or any subset using `info/warn/error/debug`).
 * - `makeStubDeps(overrides?)` — typed `SharedWriteDeps` with no-op defaults
 *   so individual tests can override only the deps they care about.
 *
 * Replaces ad-hoc `{ ... } as any` log/deps stubs flagged by the
 * 2026-05-07 test-suite audit.
 */

import type { SharedWriteDeps } from "@subbrain/agent/mcp/tools/memory/write-shared";
import type { ToolResult } from "@subbrain/agent/mcp/types";
import type { MemoryDB } from "@subbrain/core/db";
import type { LogEntry, RequestLogger } from "@subbrain/core/lib/logger";

type LogFn = (stage: string, message: string, extra?: Partial<LogEntry>) => void;

/**
 * Returns a `RequestLogger`-shaped object whose methods discard input.
 * Pipeline writers (writeShared/writeContext, etc.) only call
 * `info/warn/error/debug` — those four are enough to satisfy the structural
 * contract; the unused `parent/requestId/sessionId` private fields are not
 * part of the public surface so omitting them is type-safe via cast to the
 * public method signatures.
 */
export function noopLog(): RequestLogger {
  const noop: LogFn = () => {};
  // RequestLogger's public surface is only the four method fields. Build a
  // structurally-typed object and assert as RequestLogger — the private
  // `parent/requestId/sessionId` fields are never read by callers.
  const stub: Pick<RequestLogger, "debug" | "info" | "warn" | "error"> = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
  };
  return stub as RequestLogger;
}

/**
 * Build a typed `SharedWriteDeps` with no-op defaults. Tests pass
 * `{ memory, getRag }` (and rarely `memoryService`); everything else is
 * defaulted to a benign null/getter.
 */
export function makeStubDeps(overrides: Partial<SharedWriteDeps> = {}): SharedWriteDeps {
  const base: SharedWriteDeps = {
    memory: undefined as unknown as MemoryDB,
    getRag: () => null,
    memoryService: null,
  };
  return { ...base, ...overrides };
}

/**
 * Narrow a `ToolResult` to its error-shaped form. `r.error` may be a string
 * or `{code,message}`; this normalizes to the object shape so tests can
 * assert on `.code`/`.message` without `as any`.
 */
export function asErr(r: ToolResult): { code: string; message: string } | undefined {
  if (r.success) return undefined;
  if (typeof r.error === "string") return { code: "unknown", message: r.error };
  return r.error;
}

/** Narrow a `ToolResult` to its success-shaped data payload. */
export function asData<T = Record<string, unknown>>(r: ToolResult): T | undefined {
  return r.success ? (r.data as T) : undefined;
}
