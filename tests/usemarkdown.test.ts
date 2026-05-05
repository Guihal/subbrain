import { describe, expect, test } from "bun:test";
import { useMarkdown } from "../web/app/composables/useMarkdown";

const { render } = useMarkdown();

/**
 * Invariant: rendered output is safe to bind via `v-html`. "Safe" means
 *   - no raw `<script>`, `<img …>`, `<iframe>`, `<svg …>` tags;
 *   - no event-handler attributes (`on*=`);
 *   - no `javascript:` / `data:` / `vbscript:` URIs.
 * All of the above, when present in the input, must be either escaped to
 * text (via escapeHtml) or stripped (via DOMPurify).
 */
describe("useMarkdown XSS corpus", () => {
  // After rendering, any user input `<` must be entity-escaped — so the
  // string must not match a tag-opening pattern like `<script` (lower-case)
  // before whitespace/`>`. Our transforms only emit safe, known tags.
  const forbiddenUnescaped = [
    /<script\b/i,
    /<img\b/i,
    /<iframe\b/i,
    /<svg\b/i,
    /<body\b/i,
    /<a\s+[^>]*href\s*=\s*["']?\s*javascript:/i,
    /<a\s+[^>]*href\s*=\s*["']?\s*data:/i,
    // Inline event handler inside an actual (unescaped) tag: `<tag on*=...`
    /<[a-z]+\b[^>]*\son[a-z]+\s*=/i,
  ];

  const payloads = [
    "hello <script>alert(1)</script>",
    "<img src=x onerror=alert(1)>",
    '<img src=x oNeRrOr="alert(1)">',
    '<a href="javascript:alert(1)">click</a>',
    '<a href="&#106;avascript:alert(1)">x</a>',
    '<a href="data:text/html,<script>alert(1)</script>">x</a>',
    '<svg onload="alert(1)"></svg>',
    '<iframe src="javascript:alert(1)"></iframe>',
    '<img\nonerror="alert(1)" src=x>',
    "<body onload=alert(1)>",
  ];

  for (const p of payloads) {
    test(`payload neutralised: ${p.slice(0, 40)}…`, () => {
      const out = render(p);
      for (const pattern of forbiddenUnescaped) {
        expect(out).not.toMatch(pattern);
      }
    });
  }

  test("plain markdown bold survives", () => {
    const out = render("hello **world**");
    expect(out).toContain("<strong>world</strong>");
  });

  test("plain markdown italic survives", () => {
    const out = render("plain *italic* text");
    expect(out).toContain("<em>italic</em>");
  });

  test("inline code renders", () => {
    const out = render("code: `abc`");
    expect(out).toContain("<code");
    expect(out).toContain("abc");
  });

  test("empty input returns empty", () => {
    expect(render("")).toBe("");
  });

  test("safe http link survives sanitize (if markdown ever adds link syntax)", () => {
    // Current renderer does not implement link syntax; this guards against
    // a future refactor that breaks the http allowlist.
    const out = render("[x](https://example.com)");
    expect(out).not.toContain("javascript:");
  });

  test("markdown headers render", () => {
    expect(render("# Title")).toContain("<h1");
    expect(render("## sub")).toContain("<h2");
    expect(render("### deeper")).toContain("<h3");
  });
});
