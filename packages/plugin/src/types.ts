export type ToolResult<T = unknown> =
  | { kind: "success"; data: T }
  | { kind: "failure"; error: { code: string; message: string } }
  | { kind: "rejected"; error: { code: string; message: string } }
  | { kind: "denied"; error: { code: string; message: string } }
  | { kind: "timeout"; error: { code: string; message: string; timeout_ms: number } };

export type ToolDefinition = {
  name: string;
  description: string;
  scope: "public" | "agent-only";
};

export interface Hooks {
  onToolBefore(
    handler: (args: {
      toolName: string;
      args: unknown;
      ctx: unknown;
    }) => Promise<ToolResult | void>,
  ): void;

  onToolAfter(
    handler: (args: {
      toolName: string;
      args: unknown;
      result: ToolResult;
    }) => Promise<void>,
  ): void;

  onChatParams(
    handler: (args: {
      model: string;
      messages: unknown[];
      tools: unknown[];
      temperature?: number;
      max_tokens?: number;
    }) => Promise<void | { model: string; messages: unknown[]; tools: unknown[]; temperature?: number; max_tokens?: number }>,
  ): void;

  onChatSystemTransform(
    handler: (args: { system: string; ctx: unknown }) => Promise<string>,
  ): void;

  onPermissionAsk(
    handler: (args: { toolName: string; args: unknown }) => Promise<boolean | void>,
  ): void;
}

export interface Plugin {
  name: string;
  setup(api: { hooks: Hooks }): void | Promise<void>;
}

export function toLegacy(result: ToolResult): {
  success: boolean;
  data?: unknown;
  error?: { code: string; message: string } | string;
} {
  switch (result.kind) {
    case "success":
      return { success: true, data: result.data };
    case "failure":
    case "rejected":
    case "denied":
      return { success: false, error: result.error };
    case "timeout":
      return { success: false, error: result.error };
  }
}

export function tool<T extends ToolDefinition>(def: T): T {
  return def;
}
