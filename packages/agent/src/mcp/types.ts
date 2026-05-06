/**
 * ToolResult — legacy interface used by ALL agent-side handlers.
 * Keep this as the primary type until a full migration to the 5-variant union.
 */
export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: { code: string; message: string } | string;
}

/**
 * Canonical 5-variant discriminated union from @subbrain/plugin.
 * New code / plugin hooks should prefer this; convert via toLegacy().
 */
export type ToolResultV2 =
  | { kind: "success"; data: unknown }
  | { kind: "error"; error: { code: string; message: string } }
  | { kind: "timeout"; error: { code: "timeout"; message: string } }
  | { kind: "rejected"; error: { code: string; message: string } }
  | { kind: "denied"; error: { code: string; message: string } };

export function toLegacy(result: ToolResultV2): ToolResult {
  switch (result.kind) {
    case "success":
      return { success: true, data: result.data };
    case "error":
    case "rejected":
    case "denied":
      return { success: false, error: result.error };
    case "timeout":
      return { success: false, error: result.error };
  }
}

export function fromLegacy(result: ToolResult): ToolResultV2 {
  if (result.success) {
    return { kind: "success", data: result.data };
  }
  const err =
    typeof result.error === "string"
      ? { code: "unknown", message: result.error }
      : result.error ?? { code: "unknown", message: "unknown error" };
  return { kind: "error", error: err };
}
