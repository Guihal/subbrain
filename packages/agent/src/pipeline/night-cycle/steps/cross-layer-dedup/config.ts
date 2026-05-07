import { logger } from "@subbrain/core/lib/logger";

const log = logger.child("night.cross-layer");

export const DUP_COSINE_MIN = 0.92;
export const PROMOTE_SKIP_COSINE = 0.85;
export const WEIGHT_SUPERSEDES = 1.0;
export const WEIGHT_DERIVES = 1.0;

export interface Cfg {
  enabled: boolean;
  promoteMinAccess: number;
  promoteMinConfidence: number;
  candidateLimit: number;
}

export function parseEnvInt(key: string, fallback: number, min: number): number {
  const v = Number.parseInt(process.env[key] ?? String(fallback), 10);
  return Number.isFinite(v) && v >= min ? v : fallback;
}

export function parseEnvFloat(key: string, fallback: number, min: number, max: number): number {
  const v = Number.parseFloat(process.env[key] ?? String(fallback));
  return Number.isFinite(v) && v >= min && v <= max ? v : fallback;
}

export function readEnv(): Cfg {
  const enabled = (process.env.CROSS_LAYER_DEDUP_ENABLED ?? "true").toLowerCase() !== "false";
  return {
    enabled,
    promoteMinAccess: parseEnvInt("ARCHIVE_PROMOTE_MIN_ACCESS", 5, 1),
    promoteMinConfidence: parseEnvFloat("ARCHIVE_PROMOTE_MIN_CONFIDENCE", 0.7, 0, 1),
    candidateLimit: parseEnvInt("CROSS_LAYER_DEDUP_LIMIT", 200, 1),
  };
}

export function safeMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function logDisabled(): void {
  log.info("disabled (CROSS_LAYER_DEDUP_ENABLED=false)");
}

export function logDone(pairs: number, supersedes: number, promoted: number, errors: number): void {
  log.info("done", { meta: { pairs, supersedes, promoted, errors } });
}
