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
  signal?: AbortSignal,
): Promise<ToolResult> {
  // Early-exit if the tool-runner already aborted before we even start.
  if (signal?.aborted) {
    return { success: false, error: "aborted" };
  }
  // Playwright's callTool doesn't accept an AbortSignal today, so we race
  // the raw call against an abort promise. The in-flight browser op will
  // keep running until its own idle-timeout fires, but *we* stop awaiting
  // it — callers (agent-loop) won't block past the tool-timeout window.
  const abortP = signal
    ? new Promise<string>((_, reject) => {
        if (signal.aborted) {
          reject(new Error("aborted"));
          return;
        }
        signal.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          { once: true },
        );
      })
    : null;
  const raw = await (abortP
    ? Promise.race([exec(name, args), abortP])
    : exec(name, args));
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
    handler: async (args, ctx, signal) => {
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
        signal,
      );
    },
  });

  registry.register({
    name: "web_snapshot",
    description:
      "Get the current page content as an accessibility tree. Use after clicking or interacting to read updated state.",
    scope: "public",
    input: t.Object({}),
    handler: (_args, ctx, signal) =>
      proxy(
        (n, a) => ctx.executor.webCallTool(n, a),
        "browser_snapshot",
        {},
        signal,
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
    handler: (args, ctx, signal) =>
      proxy(
        (n, a) => ctx.executor.webCallTool(n, a),
        "browser_click",
        { element: args.element, ref: args.ref },
        signal,
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
    handler: (args, ctx, signal) => {
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
        signal,
      );
    },
  });

  registry.register({
    name: "web_back",
    description: "Go back to the previous page in browser history.",
    scope: "public",
    input: t.Object({}),
    handler: (_args, ctx, signal) =>
      proxy(
        (n, a) => ctx.executor.webCallTool(n, a),
        "browser_go_back",
        {},
        signal,
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
    handler: (args, ctx, signal) =>
      proxy(
        (n, a) => ctx.executor.webCallTool(n, a),
        "browser_press_key",
        { key: args.key },
        signal,
      ),
  });

  registry.register({
    name: "web_scroll",
    description:
      "Scroll the page. Positive dy scrolls down, negative up. Returns a fresh snapshot — use this to load more content on long / infinite-scroll pages.",
    scope: "public",
    input: t.Object({
      dy: t.Optional(
        t.Number({ description: "Vertical scroll in px (default 800, down)" }),
      ),
      dx: t.Optional(
        t.Number({ description: "Horizontal scroll in px (default 0)" }),
      ),
    }),
    handler: (args, ctx, signal) =>
      proxy(
        (n, a) => ctx.executor.webCallTool(n, a),
        "browser_scroll",
        { dy: args.dy ?? 800, dx: args.dx ?? 0 },
        signal,
      ),
  });

  registry.register({
    name: "web_screenshot",
    description:
      "Capture a PNG screenshot of the current page to /tmp. Useful for bug reports or for later vision-model analysis (main agents are text-only).",
    scope: "public",
    input: t.Object({
      full_page: t.Optional(
        t.Boolean({
          description: "Capture the full scrollable page (default false = viewport)",
        }),
      ),
    }),
    handler: (args, ctx, signal) =>
      proxy(
        (n, a) => ctx.executor.webCallTool(n, a),
        "browser_screenshot",
        { full_page: args.full_page ?? false },
        signal,
      ),
  });
}
