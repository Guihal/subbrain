/**
 * Approval registry — gated-tool seed list + operator resolver.
 *
 * Pure config + lookup functions. No DB writes, no coupling to executor.
 * 8a-2: approval registry + operator resolver.
 */
import type { AgentMode } from "./tool-registry";

export interface GatedToolEntry {
  readonly tool: string;
  readonly modes: readonly AgentMode[];
}

/** Initial gated set: both Telegram egress tools in BOTH modes. */
export const GATED_TOOLS: readonly GatedToolEntry[] = [
  { tool: "tg_send_message", modes: ["scheduled", "interactive"] },
  { tool: "tg_send_report", modes: ["scheduled", "interactive"] },
] as const;

const gatedSet = new Map<string, Set<AgentMode>>();
for (const entry of GATED_TOOLS) {
  gatedSet.set(entry.tool, new Set(entry.modes));
}

/**
 * Returns true if the tool requires approval for the given agent mode.
 * Undefined agentMode is treated as "interactive".
 * Kill-switch: APPROVAL_DISABLE=true → always false.
 */
export function requiresApproval(toolName: string, agentMode: AgentMode | undefined): boolean {
  if (process.env.APPROVAL_DISABLE === "true") return false;
  const normalized: AgentMode = agentMode ?? "interactive";
  const modes = gatedSet.get(toolName);
  return modes ? modes.has(normalized) : false;
}

/**
 * Resolve operator chat id from env.
 * APPROVAL_OPERATOR_CHAT_ID primary, TG_OWNER_CHAT_ID fallback.
 * Returns null when both unset or NaN.
 */
export function resolveOperatorChat(): number | null {
  const raw = process.env.APPROVAL_OPERATOR_CHAT_ID ?? process.env.TG_OWNER_CHAT_ID;
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Canonical JSON representation with sorted keys at all nesting levels.
 * Used for stable args_hash computation (8a-3).
 */
export function canonicalizeArgs(args: unknown): string {
  return JSON.stringify(sortKeys(args));
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
  }
  return sorted;
}
