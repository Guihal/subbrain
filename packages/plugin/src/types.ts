export type ToolResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

export type ToolDefinition = {
  name: string;
  description: string;
  scope: "public" | "agent-only";
};

export type Hooks = Record<string, never>;

export function tool<T extends ToolDefinition>(def: T): T {
  return def;
}
