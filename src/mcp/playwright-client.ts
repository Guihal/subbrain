/**
 * MCP client that connects to the Playwright MCP server via stdio.
 * Lazily spawns a headless Chromium browser on first tool call.
 *
 * Resilience: connection timeout, auto-reconnect on failures, tool-call timeout.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { logger } from "../lib/logger";

const CONNECT_TIMEOUT_MS = 30_000;
const TOOL_CALL_TIMEOUT_MS = 60_000;
const MAX_RETRIES = 2;

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export class PlaywrightClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private connectPromise: Promise<Client> | null = null;

  /** Resolve the @playwright/mcp binary path (avoids bunx download overhead) */
  private resolveMcpBin(): { command: string; args: string[] } {
    try {
      const resolved = require.resolve("@playwright/mcp/cli");
      return { command: "bun", args: [resolved, "--isolated"] };
    } catch {
      // Fallback to bunx if direct resolve fails
      return { command: "bunx", args: ["@playwright/mcp", "--isolated"] };
    }
  }

  private async connect(): Promise<Client> {
    const bin = this.resolveMcpBin();
    logger.info(
      "playwright",
      `Spawning MCP server: ${bin.command} ${bin.args.join(" ")}`,
    );

    const transport = new StdioClientTransport({
      command: bin.command,
      args: bin.args,
    });

    const client = new Client({
      name: "subbrain-agent",
      version: "1.0.0",
    });

    await withTimeout(
      client.connect(transport),
      CONNECT_TIMEOUT_MS,
      "Playwright MCP connect",
    );

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
        logger.error("playwright", `Connection failed: ${err.message}`);
        throw err;
      });
    }
    return this.connectPromise;
  }

  /** Reset connection state so next call triggers a fresh connect */
  private async resetConnection(): Promise<void> {
    try {
      if (this.transport) await this.transport.close().catch(() => {});
    } catch {
      /* ignore */
    }
    this.client = null;
    this.transport = null;
    this.connectPromise = null;
  }

  /** Call a Playwright MCP tool by name (with timeout + auto-reconnect) */
  async callTool(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<string> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const client = await this.ensureConnected();

        const result = await withTimeout(
          client.callTool({ name, arguments: args }),
          TOOL_CALL_TIMEOUT_MS,
          `Playwright ${name}`,
        );

        const parts: string[] = [];
        for (const item of result.content as Array<{
          type: string;
          text?: string;
        }>) {
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
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        logger.warn(
          "playwright",
          `callTool(${name}) attempt ${attempt + 1}/${MAX_RETRIES + 1} failed: ${lastError.message}`,
        );
        // Reset connection so next attempt spawns a fresh MCP server
        await this.resetConnection();
      }
    }

    throw lastError || new Error(`Playwright ${name} failed after retries`);
  }

  /** List available tools from the Playwright MCP server */
  async listTools(): Promise<Array<{ name: string; description?: string }>> {
    const client = await this.ensureConnected();
    const result = await client.listTools();
    return result.tools.map((t) => ({
      name: t.name,
      description: t.description,
    }));
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
