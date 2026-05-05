import DOMPurify from "isomorphic-dompurify";

/**
 * Markdown → HTML renderer for user / assistant content bound via `v-html`.
 *
 * Safety contract (PR-5):
 *   1. `escapeHtml` neutralises every HTML-break char in user input before
 *      any markdown regex runs. The transforms below inject *static* HTML
 *      with `$1` captures pulled from already-escaped text, so no user
 *      content reaches an attribute context unescaped.
 *   2. The final output is passed through `DOMPurify.sanitize` which strips
 *      event handlers, dangerous URI schemes (`javascript:` / `data:` /
 *      `vbscript:` in any obfuscation), SVG/iframe payloads, etc. This is
 *      defense-in-depth: if step 1 ever regresses, DOMPurify still blocks
 *      the bypass corpus that hand-rolled regex scrubs miss.
 *
 * DOMPurify works both on the Nuxt server (jsdom) and client (native DOM),
 * so the sanitized HTML is identical in SSR + hydration.
 */
export function useMarkdown() {
  function render(text: string): string {
    if (!text) return "";

    let html = escapeHtml(text);

    html = html.replace(
      /```(\w*)\n([\s\S]*?)```/g,
      (_m, _lang, code) =>
        `<pre class="bg-(--ui-bg-elevated) border border-(--ui-border) rounded-md p-3 my-2 overflow-x-auto text-[13px]"><code>${code}</code></pre>`,
    );

    html = html.replace(
      /`([^`]+)`/g,
      '<code class="bg-(--ui-bg-elevated) px-1.5 py-0.5 rounded text-[13px]">$1</code>',
    );

    html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

    html = html.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<em>$1</em>");

    html = html.replace(/^### (.+)$/gm, '<h3 class="font-semibold text-base mt-3 mb-1">$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2 class="font-semibold text-lg mt-3 mb-1">$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1 class="font-bold text-xl mt-3 mb-1">$1</h1>');

    html = html.replace(/^- (.+)$/gm, '<li class="ml-4 list-disc">$1</li>');

    html = html.replace(/^\d+\. (.+)$/gm, '<li class="ml-4 list-decimal">$1</li>');

    html = html.replace(/\n/g, "<br>");

    html = html.replace(/<br><pre/g, "<pre");
    html = html.replace(/<\/pre><br>/g, "</pre>");

    return DOMPurify.sanitize(html, {
      ALLOWED_TAGS: [
        "a",
        "br",
        "code",
        "em",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "li",
        "ol",
        "p",
        "pre",
        "strong",
        "ul",
        "span",
        "div",
        "b",
        "i",
      ],
      ALLOWED_ATTR: ["class", "href", "title"],
      ALLOWED_URI_REGEXP: /^(?:https?|mailto|tel):/i,
    });
  }

  function escapeHtml(s: string): string {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  return { render };
}
