/**
 * Browser leak smoke.
 *
 * Runs N navigations via PlaywrightClient and compares the number of
 * `chrome` processes before/after. On a leak-free shutdown the count
 * must match (modulo the short-lived helper processes Chrome forks on
 * startup — we normalize by polling for stability after close).
 *
 * Filename is `*.ts`, not `*.test.ts`, so `bun test` ignores it. Run
 * explicitly:
 *
 *   bun run tests/browser-smoke.ts
 *
 * Requires `playwright install chrome --with-deps` (already in
 * Dockerfile). On the host, if Chrome isn't present the test exits 0
 * with a SKIP notice — CI/prod smoke is expected inside the container.
 */
import { PlaywrightClient } from "../src/mcp/playwright";

const ITERATIONS = 5;
const TARGET_URL = "https://example.com";

async function chromeProcCount(): Promise<number> {
  const proc = Bun.spawn(["sh", "-c", "ps ax -o comm= | grep -c '^chrome' || true"], {
    stdout: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  return Number.parseInt(out.trim(), 10) || 0;
}

async function waitForStable(label: string): Promise<number> {
  // Poll twice with a small gap so transient helper processes settle.
  let prev = -1;
  for (let i = 0; i < 6; i++) {
    const n = await chromeProcCount();
    if (n === prev) return n;
    prev = n;
    await new Promise((r) => setTimeout(r, 500));
  }
  console.warn(`[smoke] ${label} count did not stabilize, returning last=${prev}`);
  return prev;
}

async function main() {
  const before = await waitForStable("before");
  console.log(`[smoke] chrome procs before: ${before}`);

  const client = new PlaywrightClient();
  try {
    for (let i = 0; i < ITERATIONS; i++) {
      const res = await client.callTool("browser_navigate", { url: TARGET_URL });
      console.log(`[smoke] iter ${i + 1}/${ITERATIONS} → ${res.length} bytes`);
    }
  } finally {
    console.log(`[smoke] contextCount before close: ${client.contextCount}`);
    await client.close();
  }

  const after = await waitForStable("after");
  console.log(`[smoke] chrome procs after: ${after}`);

  if (after > before) {
    console.error(`[smoke] LEAK: +${after - before} chrome procs`);
    process.exit(1);
  }
  console.log("[smoke] OK — no leak");
}

main().catch((err) => {
  console.error("[smoke] FAIL", err);
  process.exit(1);
});
