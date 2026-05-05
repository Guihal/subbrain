import { logger } from "@subbrain/core/lib/logger";
import type { TelegramClient } from "telegram";

const log = logger.child("userbot");

export const TG_OP_TIMEOUT_MS = 30_000;

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Telegram ${label} timed out after ${ms}ms`)),
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

/**
 * Reconnect helper. Caller passes in `getConnected/setConnected` so we don't
 * need to mutate the Userbot directly from a free function — keeps the
 * helpers testable in isolation.
 */
export async function ensureConnected(
  client: TelegramClient,
  state: { connected: boolean },
): Promise<void> {
  if (state.connected && client.connected) return;
  log.warn("Connection lost — attempting reconnect");
  state.connected = false;
  try {
    await withTimeout(client.connect(), TG_OP_TIMEOUT_MS, "reconnect");
    state.connected = true;
    log.info("Reconnected successfully");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`Reconnect failed: ${msg}`);
    throw new Error(`Telegram reconnect failed: ${msg}`);
  }
}
