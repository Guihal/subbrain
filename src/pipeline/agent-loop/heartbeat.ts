/**
 * SSE heartbeat. Emits `: ping\n\n` every 5 s so HTTP/2 proxies (Caddy)
 * do not RST idle streams while `router.chat` runs silently.
 */

export interface Heartbeat {
  stop: () => void;
}

export function setupHeartbeat(
  enqueue: (chunk: Uint8Array) => void,
  encoder: TextEncoder,
  intervalMs = 5000,
): Heartbeat {
  const timer = setInterval(() => {
    enqueue(encoder.encode(": ping\n\n"));
  }, intervalMs);
  return {
    stop: () => clearInterval(timer),
  };
}
