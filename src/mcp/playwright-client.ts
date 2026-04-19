/**
 * MCP client that connects to the Playwright MCP server via stdio.
 * Lazily spawns a headless Chromium browser on first tool call.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { logger } from "../lib/logger";

export class PlaywrightClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private connectPromise: Promise<Client> | null = null;

  private async connect(): Promise<Client> {
    const transport = new StdioClientTransport({
      command: "npx",
      args: ["@playwright/mcp", "--isolated"],
    });

    const client = new Client({
      name: "subbrain-agent",
      version: "1.0.0",
    });

    await client.connect(transport);

    this.transport = transport;
    this.client = client;

    logger.info("playwright", "MCP client connected to headless browser");
    return client;
  }

  /** Get or create the MCP client connection (lazy singleton) */
  private async ensureConnected(): Promise<Client> {
    if (this.client) return this.client;
    if (!this.connectPromise) {
      this.connectPromise = this.connect().catch((err) => {
        this.connectPromise = null;
        throw err;
      });
    }
    return this.connectPromise;
  }

  /** Call a Playwright MCP tool by name */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const client = await this.ensureConnected();
    const result = await client.callTool({ name, arguments: args });

    const parts: string[] = [];
    for (const item of result.content as Array<{ type: string; text?: string }>) {
      if (item.type === "text" && item.text) {
        parts.push(item.text);
      } else if (item.type === "image") {
        parts.push("[screenshot captured]");
      }
    }

    if (result.isError) {
      throw new Error(parts.join("\n") || "Playwright tool error");
    }

    return parts.join("\n") || "OK";
  }

  /** List available tools from the Playwright MCP server */
  async listTools(): Promise<Array<{ name: string; description?: string }>> {
    const client = await this.ensureConnected();
    const result = await client.listTools();
    return result.tools.map((t) => ({ name: t.name, description: t.description }));
  }

  /** Close browser and MCP connection */
  async close(): Promise<void> {
    try {
      if (this.client) {
        await this.callTool("browser_close").catch(() => {});
      }
      if (this.transport) {
        await this.transport.close();
      }
    } catch {
      // Ignore cleanup errors
    } finally {
      this.client = null;
      this.transport = null;
      this.connectPromise = null;
    }
  }

  /** Whether the client is currently connected */
  get connected(): boolean {
    return this.client !== null;
  }
}
