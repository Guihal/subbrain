/// <reference lib="dom" />
/**
 * Page snapshot in the textual a11y-tree format used by `browser_snapshot`
 * and consumed by parsers across the codebase (freelance scout, agent loop).
 *
 * Output shape:
 *   URL: <url>
 *   Title: <title>
 *
 *   Interactive elements (N):
 *   [1] <role> "<name>" → <href>
 *   ...
 *
 *   Text:
 *   <document.body.innerText preview>
 */
import type { Page } from "playwright";

const MAX_INTERACTIVE_ELEMENTS = 200;
const MAX_TEXT_PREVIEW = 3000;
const MAX_ELEMENT_LABEL = 120;

const INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input:not([type=hidden])",
  "textarea",
  "select",
  "[role=button]",
  "[role=link]",
  "[role=textbox]",
  "[role=combobox]",
  "[role=checkbox]",
  "[role=radio]",
  "[role=tab]",
  "[role=menuitem]",
  "[contenteditable=true]",
].join(", ");

export async function pageSnapshot(page: Page): Promise<string> {
  const url = page.url();
  const title = await page.title().catch(() => "");

  const collected = await page
    .evaluate(
      ({ sel, maxLabel, maxCount }) => {
        document.querySelectorAll("[data-pw-ref]").forEach((el) => {
          el.removeAttribute("data-pw-ref");
        });

        const isVisible = (el: Element): boolean => {
          const r = (el as HTMLElement).getBoundingClientRect();
          if (r.width === 0 && r.height === 0) return false;
          const style = window.getComputedStyle(el as HTMLElement);
          if (style.display === "none" || style.visibility === "hidden") return false;
          return true;
        };

        const label = (el: HTMLElement): string => {
          const texts = [
            (el.getAttribute("aria-label") || "").trim(),
            (el.innerText || "").trim(),
            (el.getAttribute("title") || "").trim(),
            (el.getAttribute("placeholder") || "").trim(),
            ((el as HTMLInputElement).value || "").trim(),
            (el.getAttribute("alt") || "").trim(),
            (el.getAttribute("name") || "").trim(),
          ];
          for (const t of texts) if (t) return t.slice(0, maxLabel);
          return "";
        };

        const nodes = Array.from(document.querySelectorAll(sel));
        const out: Array<{
          ref: string;
          role: string;
          type?: string;
          name: string;
          href?: string;
        }> = [];
        let counter = 0;
        for (const n of nodes) {
          if (!isVisible(n)) continue;
          counter++;
          if (counter > maxCount) break;
          const el = n as HTMLElement;
          const ref = String(counter);
          el.setAttribute("data-pw-ref", ref);
          const tag = n.tagName.toLowerCase();
          const role = el.getAttribute("role") || tag;
          const type = tag === "input" ? (n as HTMLInputElement).type : undefined;
          const href = tag === "a" ? (n as HTMLAnchorElement).href || undefined : undefined;
          out.push({ ref, role, type, name: label(el), href });
        }
        return out;
      },
      {
        sel: INTERACTIVE_SELECTOR,
        maxLabel: MAX_ELEMENT_LABEL,
        maxCount: MAX_INTERACTIVE_ELEMENTS,
      },
    )
    .catch((): Array<never> => []);

  const textPreview = await page
    .evaluate((max: number) => (document.body?.innerText || "").slice(0, max), MAX_TEXT_PREVIEW)
    .catch(() => "");

  const lines: string[] = [];
  lines.push(`URL: ${url}`);
  lines.push(`Title: ${title}`);
  if (collected.length > 0) {
    lines.push("");
    lines.push(`Interactive elements (${collected.length}):`);
    for (const el of collected) {
      let line = `[${el.ref}] ${el.role}`;
      if (el.type && el.type !== el.role) line += `(${el.type})`;
      if (el.name) line += ` "${el.name}"`;
      if (el.href) line += ` → ${el.href}`;
      lines.push(line);
    }
  }
  if (textPreview) {
    lines.push("");
    lines.push("Text:");
    lines.push(textPreview);
  }
  return lines.join("\n");
}
