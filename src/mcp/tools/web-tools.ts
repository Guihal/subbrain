/**
 * Web browsing tools (Playwright MCP) extracted from ToolExecutor.
 */
import type { PlaywrightClient } from "../playwright-client";
import type { ToolResult } from "../types";

export class WebTools {
  private playwright: PlaywrightClient | null = null;

  setPlaywright(pw: PlaywrightClient): void {
    this.playwright = pw;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    if (!this.playwright) {
      return JSON.stringify({ error: "Playwright browser not configured" });
    }
    return this.playwright.callTool(name, args);
  }
}
