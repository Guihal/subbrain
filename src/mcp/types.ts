/**
 * ToolResult discriminated union (guardrail §8).
 * `success` is the runtime discriminant; `error` is structured on the failure branch.
 * Legacy callers that return `{success:false, error:"string"}` are gradually migrated.
 */
export interface ToolResult {
  success: boolean;
  data?: unknown;
  /** Structured error on failure: {code, message}. String form is legacy. */
  error?: { code: string; message: string } | string;
}

