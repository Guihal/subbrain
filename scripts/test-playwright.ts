import { PlaywrightClient } from "../src/mcp/playwright-client";

const pw = new PlaywrightClient();
try {
  console.log("Connecting to Playwright MCP...");
  const result = await pw.callTool("browser_navigate", {
    url: "https://example.com",
  });
  console.log("SUCCESS:", result.slice(0, 500));
  await pw.close();
} catch (e: any) {
  console.error("FAILED:", e.message);
}
process.exit(0);
