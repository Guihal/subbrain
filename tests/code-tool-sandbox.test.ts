import { describe, expect, test } from "bun:test";
import { executeSandboxed } from "@subbrain/agent/pipeline/agent-loop/code-tools/sandbox";

describe("code-tool sandbox", () => {
  test("handles template literals with interpolation", async () => {
    const code = `export default async (input: string) => \`Hello \${input}!\`;`;
    const r = await executeSandboxed(code, "world");
    expect(r.success).toBe(true);
    expect(r.output).toBe("Hello world!");
  });

  test("handles plain backticks (no substitution)", async () => {
    const code = `export default async (_: string) => \`no subst\`;`;
    const r = await executeSandboxed(code, "x");
    expect(r.success).toBe(true);
    expect(r.output).toBe("no subst");
  });

  test("handles nested template literals", async () => {
    const code = `export default async (input: string) => \`outer \${\`inner \${input}\`}\`;`;
    const r = await executeSandboxed(code, "x");
    expect(r.success).toBe(true);
    expect(r.output).toBe("outer inner x");
  });

  test("blocks eval()", async () => {
    const code = `export default async (_: string) => eval("1+1");`;
    const r = await executeSandboxed(code, "x");
    expect(r.success).toBe(false);
    expect(r.error).toContain("eval()");
  });

  test("blocks new Function", async () => {
    const code = `export default async (_: string) => new Function("return 1")();`;
    const r = await executeSandboxed(code, "x");
    expect(r.success).toBe(false);
    expect(r.error).toContain("new Function");
  });
});
