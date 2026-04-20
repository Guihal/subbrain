/**
 * Web-тулы (Playwright MCP, out-of-process). Браузер держится между вызовами.
 *
 * Все хендлеры заворачивают сырой ответ Playwright в ToolResult — так агент
 * и REST получают одинаковую структуру { success, data } / { success, error }.
 */
import { t, type ToolRegistry } from "./tool-registry";
import type { ToolResult } from "../types";

async function proxy(
  exec: (name: string, args: Record<string, unknown>) => Promise<string>,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const raw = await exec(name, args);
  // Playwright-клиент при несконфигурированном браузере отдаёт JSON-строку
  // вида {"error":"..."} — прокинем как неуспех, чтобы сохранить семантику.
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && "error" in parsed) {
      return { success: false, error: String(parsed.error) };
    }
  } catch {
    // Не JSON — это ожидаемо: обычно это snapshot/текст страницы.
  }
  return { success: true, data: raw };
}

export function registerWebTools(registry: ToolRegistry): void {
  registry.register({
    name: "web_navigate",
    description:
      "Navigate to a URL in the browser and return the page content (accessibility snapshot). Only http:// and https:// allowed.",
    scope: "public",
    input: t.Object({
      url: t.String({ description: "URL to navigate to" }),
    }),
    handler: async (args, ctx) => {
      if (!/^https?:\/\//i.test(args.url)) {
        return {
          success: false,
          error: "Only http:// and https:// URLs are allowed",
        };
      }
      return proxy(
        (n, a) => ctx.executor.webCallTool(n, a),
        "browser_navigate",
        { url: args.url },
      );
    },
  });

  registry.register({
    name: "web_snapshot",
    description:
      "Get the current page content as an accessibility tree. Use after clicking or interacting to read updated state.",
    scope: "public",
    input: t.Object({}),
    handler: (_args, ctx) =>
      proxy(
        (n, a) => ctx.executor.webCallTool(n, a),
        "browser_snapshot",
        {},
      ),
  });

  registry.register({
    name: "web_click",
    description:
      "Click an element on the page by its ref number (from snapshot).",
    scope: "public",
    input: t.Object({
      element: t.String({ description: "Human-readable element description" }),
      ref: t.String({ description: "Exact ref number from the page snapshot" }),
    }),
    handler: (args, ctx) =>
      proxy(
        (n, a) => ctx.executor.webCallTool(n, a),
        "browser_click",
        { element: args.element, ref: args.ref },
      ),
  });

  registry.register({
    name: "web_type",
    description: "Type text into an input field on the page.",
    scope: "public",
    input: t.Object({
      element: t.String(),
      ref: t.String(),
      text: t.String(),
      submit: t.Optional(
        t.Boolean({ description: "Press Enter after typing (default: false)" }),
      ),
    }),
    handler: (args, ctx) => {
      const payload: Record<string, unknown> = {
        element: args.element,
        ref: args.ref,
        text: args.text,
      };
      if (args.submit) payload.submit = true;
      return proxy(
        (n, a) => ctx.executor.webCallTool(n, a),
        "browser_type",
        payload,
      );
    },
  });

  registry.register({
    name: "web_back",
    description: "Go back to the previous page in browser history.",
    scope: "public",
    input: t.Object({}),
    handler: (_args, ctx) =>
      proxy(
        (n, a) => ctx.executor.webCallTool(n, a),
        "browser_go_back",
        {},
      ),
  });

  registry.register({
    name: "web_press_key",
    description:
      "Press a keyboard key in the browser (e.g. Enter, Escape, Tab, ArrowDown).",
    scope: "public",
    input: t.Object({
      key: t.String({ description: "Key to press" }),
    }),
    handler: (args, ctx) =>
      proxy(
        (n, a) => ctx.executor.webCallTool(n, a),
        "browser_press_key",
        { key: args.key },
      ),
  });
}
