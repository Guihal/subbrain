/**
 * Diagnostic probe: open each freelance source incognito, run a11y snapshot,
 * print parsed item count + first hit, optionally save real fixtures.
 *
 *   bun run scripts/freelance-probe.ts          # probe + print
 *   bun run scripts/freelance-probe.ts --save   # also save tests/fixtures/freelance/<source>-real.txt
 */
import { writeFileSync } from "node:fs";
import type { FreelanceSource } from "@subbrain/core/db";
import { PlaywrightClient } from "../src/mcp";
import { pageSnapshot } from "../src/mcp/snapshot";
import { parseFor } from "../src/scheduler/freelance/parsers";

const FEED_URLS: Record<FreelanceSource, string> = {
  "fl.ru": "https://www.fl.ru/projects/",
  "kwork.ru": "https://kwork.ru/projects",
  "freelance.ru": "https://freelance.ru/projects",
};

const SAVE = process.argv.includes("--save");
const FIXTURE_DIR = "tests/fixtures/freelance";

async function main() {
  const pw = new PlaywrightClient();
  try {
    for (const source of Object.keys(FEED_URLS) as FreelanceSource[]) {
      console.log(`\n=== ${source} ===`);
      const page = await pw.getScopePage("freelance");
      const url = FEED_URLS[source];
      try {
        const resp = await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
        console.log(`HTTP ${resp?.status() ?? "?"}`);
        await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
        const snap = await pageSnapshot(page);
        const looksBlocked =
          /captcha|cf-challenge|just a moment|access denied|too many requests|проверьте.*робот/i.test(
            snap,
          );
        console.log(`snapshot length: ${snap.length} chars`);
        console.log(`anti-bot markers: ${looksBlocked ? "YES" : "no"}`);
        const items = parseFor(source, snap);
        console.log(`parsed items: ${items.length}`);
        if (items[0]) {
          console.log("first:", JSON.stringify(items[0], null, 2));
        }
        if (SAVE) {
          const path = `${FIXTURE_DIR}/${source}-real.txt`;
          writeFileSync(path, snap);
          console.log(`saved → ${path}`);
        }
      } catch (e) {
        console.error(`${source} probe failed:`, (e as Error).message);
      }
    }
  } finally {
    await pw.close();
  }
}

await main();
process.exit(0);
