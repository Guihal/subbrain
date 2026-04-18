/** Simple markdown → HTML renderer (no deps) */
export function useMarkdown() {
  function render(text: string): string {
    if (!text) return "";

    let html = escapeHtml(text);

    // Code blocks: ```lang\ncode\n```
    html = html.replace(
      /```(\w*)\n([\s\S]*?)```/g,
      (_m, lang, code) =>
        `<pre class="bg-(--ui-bg-elevated) border border-(--ui-border) rounded-md p-3 my-2 overflow-x-auto text-[13px]"><code>${code}</code></pre>`,
    );

    // Inline code: `code`
    html = html.replace(
      /`([^`]+)`/g,
      '<code class="bg-(--ui-bg-elevated) px-1.5 py-0.5 rounded text-[13px]">$1</code>',
    );

    // Bold: **text**
    html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

    // Italic: *text*
    html = html.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<em>$1</em>");

    // Headers
    html = html.replace(
      /^### (.+)$/gm,
      '<h3 class="font-semibold text-base mt-3 mb-1">$1</h3>',
    );
    html = html.replace(
      /^## (.+)$/gm,
      '<h2 class="font-semibold text-lg mt-3 mb-1">$1</h2>',
    );
    html = html.replace(
      /^# (.+)$/gm,
      '<h1 class="font-bold text-xl mt-3 mb-1">$1</h1>',
    );

    // Unordered lists
    html = html.replace(/^- (.+)$/gm, '<li class="ml-4 list-disc">$1</li>');

    // Ordered lists
    html = html.replace(
      /^\d+\. (.+)$/gm,
      '<li class="ml-4 list-decimal">$1</li>',
    );

    // Line breaks (but not inside pre)
    html = html.replace(/\n/g, "<br>");

    // Clean up: remove <br> right after </pre> and before <pre>
    html = html.replace(/<br><pre/g, "<pre");
    html = html.replace(/<\/pre><br>/g, "</pre>");

    return html;
  }

  function escapeHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  return { render };
}
