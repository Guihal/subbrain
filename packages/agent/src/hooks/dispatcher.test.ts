import { describe, expect, test } from "bun:test";
import type { Plugin, ToolResult } from "@subbrain/plugin";
import { HooksDispatcher } from "./dispatcher";

describe("HooksDispatcher", () => {
  test("registration order respected for before hooks", async () => {
    const order: string[] = [];
    const mk = (n: string): Plugin => ({
      name: n,
      setup({ hooks }) {
        hooks.onToolBefore(async () => {
          order.push(n);
          return undefined;
        });
      },
    });
    const d = new HooksDispatcher();
    d.register(mk("p1"));
    d.register(mk("p2"));
    await d.runToolBefore("t", {}, {});
    expect(order).toEqual(["p1", "p2"]);
  });

  test("error isolation — throw in hook N does not stop hook N+1", async () => {
    const order: string[] = [];
    const d = new HooksDispatcher();
    d.register({
      name: "p1",
      setup({ hooks }) {
        hooks.onToolBefore(async () => {
          throw new Error("boom");
        });
      },
    });
    d.register({
      name: "p2",
      setup({ hooks }) {
        hooks.onToolBefore(async () => {
          order.push("p2");
          return undefined;
        });
      },
    });
    await d.runToolBefore("t", {}, {});
    expect(order).toEqual(["p2"]);
  });

  test("short-circuit — before hook returns non-success stops remaining", async () => {
    const order: string[] = [];
    const failResult: ToolResult = { kind: "failure", error: { code: "x", message: "m" } };
    const d = new HooksDispatcher();
    d.register({
      name: "p1",
      setup({ hooks }) {
        hooks.onToolBefore(async () => failResult);
      },
    });
    d.register({
      name: "p2",
      setup({ hooks }) {
        hooks.onToolBefore(async () => {
          order.push("p2");
          return undefined;
        });
      },
    });
    const result = await d.runToolBefore("t", {}, {});
    expect(result).toBe(failResult);
    expect(order).toEqual([]);
  });

  test("after-hooks run even on short-circuit", async () => {
    const order: string[] = [];
    const failResult: ToolResult = { kind: "failure", error: { code: "x", message: "m" } };
    const d = new HooksDispatcher();
    d.register({
      name: "p1",
      setup({ hooks }) {
        hooks.onToolBefore(async () => failResult);
        hooks.onToolAfter(async () => {
          order.push("p1-after");
        });
      },
    });
    const result = await d.runToolBefore("t", {}, {});
    expect(result).toBe(failResult);
    await d.runToolAfter("t", {}, failResult);
    expect(order).toEqual(["p1-after"]);
  });

  test("permission ask default true, one false → false", async () => {
    const d = new HooksDispatcher();
    d.register({
      name: "p1",
      setup({ hooks }) {
        hooks.onPermissionAsk(async () => true);
      },
    });
    d.register({
      name: "p2",
      setup({ hooks }) {
        hooks.onPermissionAsk(async () => false);
      },
    });
    expect(await d.runPermissionAsk("t", {})).toBe(false);
  });

  test("permission ask default true when no handlers", async () => {
    const d = new HooksDispatcher();
    expect(await d.runPermissionAsk("t", {})).toBe(true);
  });

  test("chat params merge — last writer wins", async () => {
    const d = new HooksDispatcher();
    d.register({
      name: "p1",
      setup({ hooks }) {
        hooks.onChatParams(async () => ({ model: "a", messages: [], tools: [] }));
      },
    });
    d.register({
      name: "p2",
      setup({ hooks }) {
        hooks.onChatParams(async () => ({ model: "b", messages: [], tools: [] }));
      },
    });
    const result = await d.runChatParams({ model: "x", messages: [], tools: [] });
    expect(result).toEqual({ model: "b", messages: [], tools: [] });
  });

  test("chat params returns undefined when no handlers", async () => {
    const d = new HooksDispatcher();
    const result = await d.runChatParams({ model: "x", messages: [], tools: [] });
    expect(result).toBeUndefined();
  });

  test("system transform piping", async () => {
    const d = new HooksDispatcher();
    d.register({
      name: "p1",
      setup({ hooks }) {
        hooks.onChatSystemTransform(async ({ system }) => `${system}-A`);
      },
    });
    d.register({
      name: "p2",
      setup({ hooks }) {
        hooks.onChatSystemTransform(async ({ system }) => `${system}-B`);
      },
    });
    const result = await d.runChatSystemTransform("base", {});
    expect(result).toBe("base-A-B");
  });
});
