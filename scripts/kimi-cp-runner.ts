#!/usr/bin/env bun
/**
 * Kimi checkpoint runner. Usage:
 *   bun run scripts/kimi-cp-runner.ts <cp0|cp1|cp2|cp3|all> <packet-id>
 */

const NAV = "docs/tasks/kimi-nav.md";
const CP_MAP: Record<string, string> = { cp0: "cp0", cp1: "cp1", cp2: "cp2", cp3: "cp3" };

async function readNav(): Promise<string> {
  return Bun.file(NAV).text();
}
async function writeNav(t: string) {
  await Bun.write(NAV, t);
}

function findPacket(lines: string[], id: string): number {
  for (let i = 0; i < lines.length; i++)
    if (lines[i].split("|").map((c) => c.trim())[1] === id) return i;
  return -1;
}

function patchRow(line: string, status: string, last: string, blocker: string): string {
  const c = line.split("|");
  if (c.length < 7) return line;
  c[3] = ` \`${status}\` `;
  c[4] = last === "—" ? " — " : ` \`${last}\` `;
  c[5] = blocker === "—" ? " — " : ` \`${blocker}\` `;
  return c.join("|");
}

async function runCp(cp: string): Promise<{ ok: boolean; err?: string }> {
  const s = CP_MAP[cp];
  if (!s) return { ok: false, err: `unknown_cp ${cp}` };
  const p = Bun.spawn(["bun", "run", s], { stdout: "pipe", stderr: "pipe" });
  const code = await p.exited;
  if (code === 0) return { ok: true };
  const tail = (await new Response(p.stderr).text()).trim().split("\n").slice(-3).join("; ");
  return { ok: false, err: tail || `exit ${code}` };
}

async function updateNav(
  id: string,
  status: string,
  last: string,
  blocker: string,
): Promise<boolean> {
  const lines = (await readNav()).split("\n");
  const i = findPacket(lines, id);
  if (i === -1) return false;
  lines[i] = patchRow(lines[i], status, last, blocker);
  await writeNav(lines.join("\n"));
  return true;
}

async function main() {
  const [target, id] = process.argv.slice(2);
  if (!target || !id) {
    console.error("FAIL: usage: ... <cp0|cp1|cp2|cp3|all> <packet-id>");
    process.exit(1);
  }
  const targets = target === "all" ? ["cp0", "cp1", "cp2", "cp3"] : [target];
  for (const cp of targets)
    if (!CP_MAP[cp]) {
      console.error(`FAIL: unknown_cp ${cp}`);
      process.exit(1);
    }
  if (findPacket((await readNav()).split("\n"), id) === -1) {
    console.error("FAIL: unknown_packet");
    process.exit(1);
  }
  for (const cp of targets) {
    const r = await runCp(cp);
    if (r.ok) {
      await updateNav(id, `${cp}_passed`, cp, "—");
      console.log(`OK ${id}: ${cp} passed`);
    } else {
      await updateNav(id, "fail", cp, `${cp} failed`);
      console.error(`FAIL: ${cp}: ${r.err}`);
      process.exit(1);
    }
  }
}

// --- self-tests ---
if (!import.meta.main) {
  const { describe, test, expect } = await import("bun:test");
  const row = "| P0-1 | README sync | `not_started` | — | — | CRITIC-PASSED |";
  describe("patchRow", () => {
    test("pass", () => {
      const o = patchRow(row, "cp0_passed", "cp0", "—");
      expect(o).toInclude("`cp0_passed`");
      expect(o).toInclude("`cp0`");
    });
    test("fail", () => {
      const o = patchRow(row, "fail", "cp1", "cp1 failed");
      expect(o).toInclude("`fail`");
      expect(o).toInclude("`cp1 failed`");
    });
  });
  describe("findPacket", () => {
    const lines = [
      "| Phase | Packet | Status | Last CP | Blocker | Notes |",
      "|---|---|---|---|---|---|",
      "| P0-1 | README sync | `not_started` | — | — | CRITIC-PASSED |",
    ];
    test("found", () => {
      expect(findPacket(lines, "P0-1")).toBe(2);
    });
    test("missing", () => {
      expect(findPacket(lines, "NOPE")).toBe(-1);
    });
  });
}

if (import.meta.main) main();
