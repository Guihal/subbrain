import { logger } from "@subbrain/core/lib/logger";
import type { Hooks, Plugin, ToolResult } from "@subbrain/plugin";

function le(name: string, err: unknown) {
  logger.error("plugin", name, {
    meta: { error: err instanceof Error ? err.message : String(err) },
  });
}

type B = (args: {
  toolName: string;
  args: unknown;
  ctx: unknown;
}) => Promise<ToolResult | undefined>;
type A = (args: { toolName: string; args: unknown; result: ToolResult }) => Promise<void>;
type ChatParams = {
  model: string;
  messages: unknown[];
  tools: unknown[];
  temperature?: number;
  max_tokens?: number;
};
type C = (params: ChatParams) => Promise<undefined | ChatParams>;
type S = (args: { system: string; ctx: unknown }) => Promise<string>;
type P = (args: { toolName: string; args: unknown }) => Promise<boolean | undefined>;

class PluginHooks implements Hooks {
  b: B[] = [];
  a: A[] = [];
  c: C[] = [];
  s: S[] = [];
  p: P[] = [];
  onToolBefore(h: B) {
    this.b.push(h);
  }
  onToolAfter(h: A) {
    this.a.push(h);
  }
  onChatParams(h: C) {
    this.c.push(h);
  }
  onChatSystemTransform(h: S) {
    this.s.push(h);
  }
  onPermissionAsk(h: P) {
    this.p.push(h);
  }
}

export class HooksDispatcher {
  private plugins: Plugin[] = [];
  private hooksMap = new Map<Plugin, PluginHooks>();
  register(plugin: Plugin): void {
    const hooks = new PluginHooks();
    this.plugins.push(plugin);
    this.hooksMap.set(plugin, hooks);
    plugin.setup({ hooks });
  }
  async runToolBefore(
    toolName: string,
    args: unknown,
    ctx: unknown,
  ): Promise<ToolResult | undefined> {
    for (const plugin of this.plugins) {
      const hooksB = this.hooksMap.get(plugin)!;
      for (const handler of hooksB.b) {
        try {
          const result = await handler({ toolName, args, ctx });
          if (result && result.kind !== "success") return result;
        } catch (err) {
          le(plugin.name, err);
        }
      }
    }
    return undefined;
  }
  async runToolAfter(toolName: string, args: unknown, result: ToolResult): Promise<void> {
    for (const plugin of this.plugins) {
      const hooksA = this.hooksMap.get(plugin)!;
      for (const handler of hooksA.a) {
        try {
          await handler({ toolName, args, result });
        } catch (err) {
          le(plugin.name, err);
        }
      }
    }
  }
  async runChatParams(params: ChatParams): Promise<undefined | ChatParams> {
    let merged: ChatParams | undefined;
    for (const plugin of this.plugins) {
      const hooksC = this.hooksMap.get(plugin)!;
      for (const handler of hooksC.c) {
        try {
          const r = await handler(merged ?? params);
          if (r) merged = r;
        } catch (err) {
          le(plugin.name, err);
        }
      }
    }
    return merged;
  }
  async runChatSystemTransform(system: string, ctx: unknown): Promise<string> {
    let out = system;
    for (const plugin of this.plugins) {
      const hooksS = this.hooksMap.get(plugin)!;
      for (const handler of hooksS.s) {
        try {
          out = await handler({ system: out, ctx });
        } catch (err) {
          le(plugin.name, err);
        }
      }
    }
    return out;
  }
  async runPermissionAsk(toolName: string, args: unknown): Promise<boolean> {
    for (const plugin of this.plugins) {
      const hooksP = this.hooksMap.get(plugin)!;
      for (const handler of hooksP.p) {
        try {
          const r = await handler({ toolName, args });
          if (r === false) return false;
        } catch (err) {
          le(plugin.name, err);
        }
      }
    }
    return true;
  }
}
