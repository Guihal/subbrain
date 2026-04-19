/**
 * Code Tools — Types
 */

export interface CodeTool {
  id: string;
  name: string;
  description: string;
  code: string;
  enabled: boolean;
  run_count: number;
  error_count: number;
  last_run_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export interface CodeToolExecResult {
  success: boolean;
  output?: string;
  error?: string;
  durationMs: number;
}

export const CODE_TOOL_LIMITS = {
  MAX_CODE_SIZE: 10_000, // 10KB source
  MAX_OUTPUT_SIZE: 10_000, // 10KB output
  TIMEOUT_MS: 30_000, // 30s execution
  MAX_ERROR_COUNT: 3, // auto-disable threshold
} as const;
