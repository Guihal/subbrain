import { chmodSync } from "node:fs";
import { logger } from "../../lib/logger";
import { fetchJson } from "../../lib/http-client";
import { HttpError } from "../../lib/errors";
import { ProviderError } from "../nvidia";

const log = logger.child("copilot");

const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const DEVICE_TOKEN_URL = "https://github.com/login/oauth/access_token";
const COPILOT_CLIENT_ID = "Iv1.b507a08c87ecfe98";
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const MAX_FETCH_TOKEN_RETRIES = 2;

interface CopilotToken {
  token: string;
  expires_at: number;
}

function writeTokenFile(path: string, token: string): Promise<number> {
  return Bun.write(path, token).then((n) => {
    try {
      chmodSync(path, 0o600);
    } catch {
      /* non-fatal */
    }
    return n;
  });
}

export class CopilotAuth {
  private oauthToken: string;
  private cachedToken: CopilotToken | null = null;
  private refreshPromise: Promise<CopilotToken> | null = null;
  private initPromise: Promise<void> | null = null;
  private tokenFilePath: string;

  constructor(oauthToken: string, tokenFilePath?: string) {
    this.oauthToken = oauthToken;
    this.tokenFilePath = tokenFilePath || "data/copilot-oauth.txt";
  }

  async init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.doInit().finally(() => {
        // keep initPromise resolved; do not reset to null (init is one-shot)
      });
    }
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    if (this.oauthToken.startsWith("ghu_")) {
      log.info("Using provided OAuth token (ghu_)");
      return;
    }
    try {
      const saved = await Bun.file(this.tokenFilePath).text();
      const trimmed = saved.trim();
      if (trimmed.startsWith("ghu_")) {
        this.oauthToken = trimmed;
        log.info(`Loaded OAuth token from ${this.tokenFilePath}`);
        return;
      }
    } catch {
      /* no saved token, continue to device flow */
    }
    await this.deviceFlow();
  }

  private async deviceFlow(): Promise<void> {
    log.info("Starting GitHub Device OAuth flow...");
    let codeData: {
      device_code: string;
      user_code: string;
      verification_uri: string;
      expires_in: number;
      interval: number;
    };
    try {
      codeData = await fetchJson(
        DEVICE_CODE_URL,
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: `client_id=${COPILOT_CLIENT_ID}&scope=copilot`,
        },
        { timeoutMs: 30_000 },
      );
    } catch (e) {
      if (e instanceof HttpError)
        throw new ProviderError(e.status, `Device code request failed: ${e.body}`);
      throw e;
    }

    log.info("═══════════════════════════════════════════════════════");
    log.info("AUTHORIZE COPILOT:");
    log.info(`  1. Open: ${codeData.verification_uri}`);
    log.info(`  2. Enter code: ${codeData.user_code}`);
    log.info("  Waiting for authorization...");
    log.info("═══════════════════════════════════════════════════════");

    const deadline = Date.now() + codeData.expires_in * 1000;
    const interval = (codeData.interval || 5) * 1000;

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, interval));
      let tokenData: { access_token?: string; error?: string };
      try {
        tokenData = await fetchJson(
          DEVICE_TOKEN_URL,
          {
            method: "POST",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: `client_id=${COPILOT_CLIENT_ID}&device_code=${codeData.device_code}&grant_type=urn:ietf:params:oauth:grant-type:device_code`,
          },
          { timeoutMs: 30_000 },
        );
      } catch (e) {
        if (e instanceof HttpError) {
          throw new ProviderError(e.status, `Device token request failed: ${e.body}`);
        }
        throw e;
      }

      if (tokenData.access_token) {
        this.oauthToken = tokenData.access_token;
        await writeTokenFile(this.tokenFilePath, this.oauthToken);
        log.info(`OAuth token obtained and saved to ${this.tokenFilePath}`);
        return;
      }
      if (tokenData.error === "authorization_pending") continue;
      if (tokenData.error === "slow_down") {
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      throw new ProviderError(400, `Device flow failed: ${tokenData.error}`);
    }
    throw new ProviderError(408, "Device flow timed out — user did not authorize");
  }

  async getToken(): Promise<string> {
    const now = Date.now() / 1000;
    if (this.cachedToken && this.cachedToken.expires_at - TOKEN_REFRESH_MARGIN_MS / 1000 > now) {
      return this.cachedToken.token;
    }
    if (!this.refreshPromise) {
      this.refreshPromise = this.fetchToken().finally(() => {
        this.refreshPromise = null;
      });
    }
    this.cachedToken = await this.refreshPromise;
    return this.cachedToken.token;
  }

  /** Clear session-token cache. In-flight refreshPromise is left alone. */
  invalidateToken(): void {
    this.cachedToken = null;
  }

  private async fetchToken(retryDepth = 0): Promise<CopilotToken> {
    let data: CopilotToken;
    try {
      data = await fetchJson<CopilotToken>(
        COPILOT_TOKEN_URL,
        {
          headers: {
            Authorization: `token ${this.oauthToken}`,
            Accept: "application/json",
            "User-Agent": "GithubCopilot/1.0",
            "Editor-Version": "vscode/1.100.0",
            "Editor-Plugin-Version": "copilot-chat/0.25.0",
          },
        },
        { timeoutMs: 10_000 },
      );
    } catch (e) {
      if (e instanceof HttpError) {
        if (e.status === 401 || e.status === 404) {
          if (retryDepth >= MAX_FETCH_TOKEN_RETRIES) {
            log.error(`OAuth re-auth exhausted after ${retryDepth} retries (status=${e.status})`);
            throw new ProviderError(e.status, `copilot_auth_exhausted after ${retryDepth} retries`);
          }
          log.info(`OAuth token invalid/expired (attempt ${retryDepth + 1}/${MAX_FETCH_TOKEN_RETRIES}), re-running device flow…`);
          try {
            await writeTokenFile(this.tokenFilePath, "");
          } catch {}
          await this.deviceFlow();
          return this.fetchToken(retryDepth + 1);
        }
        throw new ProviderError(e.status, `Copilot token fetch failed: ${e.body}`);
      }
      throw e;
    }
    log.info(`Session token refreshed, expires at ${new Date(data.expires_at * 1000).toISOString()}`);
    return data;
  }
}
