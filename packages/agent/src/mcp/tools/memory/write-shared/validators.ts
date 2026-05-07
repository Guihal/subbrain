/** Validation helpers + error-code enum for shared-layer writes. */

import { logger } from "@subbrain/core/lib/logger";
import { incrementCounter } from "@subbrain/core/lib/metrics";
import type { ToolResult } from "../../../types";

const log = logger.child("memory.write-shared");

export enum SharedWriteErr {
  VALIDATION_FAILED = "validation_failed",
  INSERT_FAILED = "insert_failed",
  SUPERSEDE_LINK_FAILED = "supersede_link_failed",
  EMBED_FAILED = "embed_failed",
  EMBED_EMPTY = "embed_empty",
  TXN_FAILED = "txn_failed",
  NO_INSERT_PATH = "no_insert_path",
  SUPERSEDE_ROLLBACK_FAILED = "supersede_rollback_failed",
}

export function mode(): "warn" | "reject" {
  return process.env.MEMORY_VALIDATORS_ENFORCE === "reject" ? "reject" : "warn";
}

export function maybeReject(reason: string, ctx: Record<string, unknown>): ToolResult | null {
  const m = mode();
  incrementCounter("memory_write_validator_triggered_total", { enforce_mode: m });
  if (m === "reject")
    return { success: false, error: { code: SharedWriteErr.VALIDATION_FAILED, message: reason } };
  log.warn(`would_reject: ${reason}`, { meta: ctx });
  return null;
}

export function buildError(code: SharedWriteErr, err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { success: false, error: { code, message } };
}
