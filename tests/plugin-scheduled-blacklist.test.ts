import { describe, expect, test } from "bun:test";
import {
  isHiddenInMode,
  STATEFUL_CLIENT_CODE_TOOLS,
  scheduledBlacklistPlugin,
} from "@subbrain/agent/plugins-internal/scheduled-blacklist";
import { toLegacy } from "@subbrain/plugin";

describe("scheduled-blacklist plugin", () => {
  test("STATEFUL_CLIENT_CODE_TOOLS contains expected names", () => {
    expect(STATEFUL_CLIENT_CODE_TOOLS.has("overdue_reminder")).toBe(true);
    expect(STATEFUL_CLIENT_CODE_TOOLS.has("silent_projects_check")).toBe(true);
    expect(STATEFUL_CLIENT_CODE_TOOLS.has("critical_clients_monitor")).toBe(true);
    expect(STATEFUL_CLIENT_CODE_TOOLS.has("client_followup_check")).toBe(true);
    expect(STATEFUL_CLIENT_CODE_TOOLS.size).toBe(4);
  });

  test("isHiddenInMode hides in scheduled mode only", () => {
    expect(isHiddenInMode("overdue_reminder", "scheduled")).toBe(true);
    expect(isHiddenInMode("overdue_reminder", "interactive")).toBe(false);
    expect(isHiddenInMode("other_tool", "scheduled")).toBe(false);
  });

  test("plugin rejects stateful tools in scheduled mode", async () => {
    const hooks = { onToolBefore: [] as any[] };
    scheduledBlacklistPlugin.setup({
      hooks: {
        onToolBefore(h) {
          hooks.onToolBefore.push(h);
        },
        onToolAfter() {},
        onChatParams() {},
        onChatSystemTransform() {},
        onPermissionAsk() {},
      },
    });

    expect(hooks.onToolBefore.length).toBe(1);
    const handler = hooks.onToolBefore[0];

    for (const name of STATEFUL_CLIENT_CODE_TOOLS) {
      const result = await handler({ toolName: name, ctx: { agentMode: "scheduled" } });
      expect(result).toBeDefined();
      expect(result?.kind).toBe("rejected");
      expect(result?.error.code).toBe("focus_blocked");
      const legacy = toLegacy(result!);
      expect(legacy.success).toBe(false);
    }
  });

  test("plugin allows stateful tools in interactive mode", async () => {
    const hooks = { onToolBefore: [] as any[] };
    scheduledBlacklistPlugin.setup({
      hooks: {
        onToolBefore(h) {
          hooks.onToolBefore.push(h);
        },
        onToolAfter() {},
        onChatParams() {},
        onChatSystemTransform() {},
        onPermissionAsk() {},
      },
    });

    const handler = hooks.onToolBefore[0];
    for (const name of STATEFUL_CLIENT_CODE_TOOLS) {
      const result = await handler({ toolName: name, ctx: { agentMode: "interactive" } });
      expect(result).toBeUndefined();
    }
  });

  test("plugin allows non-stateful tools in scheduled mode", async () => {
    const hooks = { onToolBefore: [] as any[] };
    scheduledBlacklistPlugin.setup({
      hooks: {
        onToolBefore(h) {
          hooks.onToolBefore.push(h);
        },
        onToolAfter() {},
        onChatParams() {},
        onChatSystemTransform() {},
        onPermissionAsk() {},
      },
    });

    const handler = hooks.onToolBefore[0];
    const result = await handler({ toolName: "memory_search", ctx: { agentMode: "scheduled" } });
    expect(result).toBeUndefined();
  });

  test("plugin allows when agentMode is missing (backward-compat)", async () => {
    const hooks = { onToolBefore: [] as any[] };
    scheduledBlacklistPlugin.setup({
      hooks: {
        onToolBefore(h) {
          hooks.onToolBefore.push(h);
        },
        onToolAfter() {},
        onChatParams() {},
        onChatSystemTransform() {},
        onPermissionAsk() {},
      },
    });

    const handler = hooks.onToolBefore[0];
    const result = await handler({ toolName: "overdue_reminder", ctx: {} });
    expect(result).toBeUndefined();
  });
});
