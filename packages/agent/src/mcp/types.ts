/**
 * ToolResult discriminated union (guardrail §8).
 * Re-export from @subbrain/plugin — canonical 5-variant `kind` union.
 * Legacy callers that need `{success,data}/{success,error}` use `toLegacy()`.
 */
export { type ToolResult, toLegacy } from "@subbrain/plugin";
